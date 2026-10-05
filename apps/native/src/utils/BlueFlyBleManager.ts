/**
 * BlueFlyBleManager — thin native-only I/O wrapper around
 * react-native-ble-plx for the BlueFly Vario transparent serial-over-BLE
 * bridge. Owns only I/O; all parsing/checksums/command-building delegate
 * to the shared, pure @open-vfr/shared/blueflyVario module.
 *
 * See native/docs/ble-vario-plan.md §2 and native/ble-pressure.md §1-2 for
 * the full protocol/connection-sequence rationale.
 */

import { BleManager, type Device, type Subscription } from 'react-native-ble-plx'
import { Buffer } from 'buffer'
import { appendChunk, buildSetModeCmd, buildSetRateCmd } from '@open-vfr/shared/blueflyVario'

export const BLUEFLY_SERVICE_UUID = '49535343-FE7D-4AE5-8FA9-9FAFD205E455'
export const BLUEFLY_TX_CHAR_UUID = '49535343-1E4D-4BD9-BA61-23C647249616'  // notify: device -> app
export const BLUEFLY_RX_CHAR_UUID = '49535343-8841-43F4-A8D4-ECBE34729BB3'  // write-without-response: app -> device

// Advertised (scan-record) serviceData UUID seen on a real BlueFly unit —
// present even when the GATT UART service UUID above is NOT in the scan
// record (serviceUUIDs: null on that unit). Far more vendor-distinctive than
// the generic 49535343-... UART-bridge service (shared by unrelated modules)
// or the mutable advertised name. See native/docs/ble-vario-plan.md.
export const BLUEFLY_ADV_SERVICE_DATA_UUID = '0000feda-0000-1000-8000-00805f9b34fb'

const NAME_PREFIX     = 'Bluefly'
const REQUEST_MTU     = 512
const SETTLE_DELAY_MS = 600

// Telemetry config per ble-pressure.md §3.1: $BFX (mode 6) @ 5Hz — the
// doc's own recommendation, "to balance firmware Kalman filtering with
// battery life and JS execution overhead." We still run our own Kalman
// filter (packages/shared/src/baroKalman.ts) on the sentence's pressurePa
// field rather than trust its vario_cms field directly, but at this rate
// (not raw mode's 50Hz) so battery/temp/voltage keep arriving on every
// sentence — no need for the mode-flipping hack raw mode required.
const OUTPUT_MODE_BFX     = 6
const OUTPUT_RATE_DIVISOR = 10  // 50 Hz base / 10 = 5 Hz

export type FoundDevice = { id: string; name: string | null; rssi: number | null }

/**
 * Single BleManager instance per app — react-native-ble-plx docs recommend
 * exactly this; never construct more than one.
 */
export class BlueFlyBleManager {
  private manager = new BleManager()
  private device: Device | null = null
  private lineBuf = ''
  private notifySub: Subscription | null = null
  private lineListeners: Array<(line: string) => void> = []
  private disconnectSub: Subscription | null = null
  private disconnectListeners: Array<() => void> = []
  private intentionalDisconnect = false

  private emitDisconnected(): void {
    if (this.intentionalDisconnect) return
    for (const cb of this.disconnectListeners) cb()
  }

  /** Fires when the link drops or notifications error out unexpectedly
   *  (device moved out of range, powered off, GATT error) — NOT on disconnect().
   *  Android's autoConnect restores the raw link on its own but the
   *  notification subscription dies with it, so callers must reconnect. */
  onDisconnected(cb: () => void): () => void {
    this.disconnectListeners.push(cb)
    return () => { this.disconnectListeners = this.disconnectListeners.filter(x => x !== cb) }
  }

  /** Starts a scan filtered primarily on the BlueFly advertised serviceData UUID
   *  (0xFEDA), with the GATT UART service UUID + name-prefix as fallbacks.
   *  Note: 49535343-... is Microchip's generic transparent-UART service, reused
   *  by many unrelated cheap BLE serial modules (not unique to BlueFly), and on
   *  at least one real unit it isn't even present in the scan record at all —
   *  serviceData's 0xFEDA entry is the distinctive one. Returns a stop-scan fn. */
  scan(onFound: (device: FoundDevice) => void): () => void {
    const matches = (d: Device) =>
      Object.keys(d.serviceData ?? {}).some(k => k.toLowerCase() === BLUEFLY_ADV_SERVICE_DATA_UUID)
      || (d.name?.startsWith(NAME_PREFIX) ?? false)

    this.manager.startDeviceScan([BLUEFLY_SERVICE_UUID], { legacyScan: true }, (error, scannedDevice) => {
      if (error || !scannedDevice || !matches(scannedDevice)) return
      onFound({ id: scannedDevice.id, name: scannedDevice.name, rssi: scannedDevice.rssi })
    })

    // Fallback: also scan unfiltered by service, since the GATT UART service
    // UUID isn't reliably present in the scan record — still gated by matches().
    this.manager.startDeviceScan(null, { legacyScan: true }, (error, scannedDevice) => {
      if (error || !scannedDevice) return
      // DEV-only diagnostic: dump every nearby device's full advertisement
      // record (manufacturerData/serviceData/localName) so we can capture
      // what a real BlueFly unit actually broadcasts, to find something
      // more vendor-distinctive than the generic UART service UUID or the
      // (mutable) advertised name. Remove once BlueFly's real adv record is
      // known and a proper filter replaces the name-prefix heuristic.
      if (__DEV__) {
        console.log('[BLE scan]', {
          id:               scannedDevice.id,
          name:             scannedDevice.name,
          localName:        scannedDevice.localName,
          rssi:             scannedDevice.rssi,
          serviceUUIDs:     scannedDevice.serviceUUIDs,
          serviceData:      scannedDevice.serviceData,
          manufacturerData: scannedDevice.manufacturerData,
        })
      }
      if (!matches(scannedDevice)) return
      onFound({ id: scannedDevice.id, name: scannedDevice.name, rssi: scannedDevice.rssi })
    })

    return () => { this.manager.stopDeviceScan() }
  }

  /** Connect + negotiate MTU/priority + discover services, per ble-pressure.md §1.2. */
  async connect(deviceId: string): Promise<void> {
    this.manager.stopDeviceScan()
    // Clean up any previous (possibly half-dead) session before reconnecting.
    this.intentionalDisconnect = true
    this.notifySub?.remove(); this.notifySub = null
    this.disconnectSub?.remove(); this.disconnectSub = null
    if (this.device) await this.manager.cancelDeviceConnection(this.device.id).catch(() => {})
    this.device = null
    this.intentionalDisconnect = false

    let device = await this.manager.connectToDevice(deviceId, { autoConnect: true })
    device = await device.requestMTU(REQUEST_MTU)
    try {
      // Android-only; iOS has no equivalent knob and rejects/no-ops this call.
      await device.requestConnectionPriority(1 /* CONNECTION_PRIORITY_HIGH */)
    } catch {
      // Non-fatal — proceed without the priority bump.
    }

    // Settle delay before service discovery avoids a real race condition on
    // some Android BLE stacks per the spec.
    await new Promise(resolve => setTimeout(resolve, SETTLE_DELAY_MS))

    device = await device.discoverAllServicesAndCharacteristics()
    this.device = device
    this.lineBuf = ''
    this.disconnectSub = this.manager.onDeviceDisconnected(device.id, () => this.emitDisconnected())

    // monitorCharacteristicForDevice already writes the CCCD (0x01 0x00) to
    // enable notifications internally — no need to hand-write the descriptor.
    this.notifySub = this.manager.monitorCharacteristicForDevice(
      device.id, BLUEFLY_SERVICE_UUID, BLUEFLY_TX_CHAR_UUID,
      (error, characteristic) => {
        if (error) { this.emitDisconnected(); return }
        if (!characteristic?.value) return
        const chunk = Buffer.from(characteristic.value, 'base64').toString('ascii')
        const { lines, rest } = appendChunk(this.lineBuf, chunk)
        this.lineBuf = rest
        for (const line of lines) {
          for (const cb of this.lineListeners) cb(line)
        }
      },
    )

    // Explicitly (re)configure the device to $BFX @ 5Hz per ble-pressure.md
    // §3.1 — don't rely on whatever mode/rate it was previously left in.
    // Non-fatal if it fails.
    try {
      await this.sendCommand(buildSetModeCmd(OUTPUT_MODE_BFX))
      await this.sendCommand(buildSetRateCmd(OUTPUT_RATE_DIVISOR))
    } catch {
      // Non-fatal — proceed with whatever telemetry the device already sends.
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true
    this.disconnectSub?.remove()
    this.disconnectSub = null
    this.notifySub?.remove()
    this.notifySub = null
    if (this.device) {
      this.manager.cancelDeviceConnection(this.device.id).catch(() => {})
    }
    this.device = null
    this.lineBuf = ''
  }

  isConnected(): boolean {
    return this.device != null
  }

  /** Fires once per complete line (already stripped of \r\n). Returns an unsubscribe fn. */
  onLine(cb: (line: string) => void): () => void {
    this.lineListeners.push(cb)
    return () => {
      this.lineListeners = this.lineListeners.filter(x => x !== cb)
    }
  }

  /** Write a pre-built `$...*CC\r\n` command string (see blueflyVario.ts's buildXxxCmd helpers). */
  async sendCommand(cmd: string): Promise<void> {
    if (!this.device) throw new Error('BlueFlyBleManager: not connected')
    const base64 = Buffer.from(cmd, 'ascii').toString('base64')
    await this.manager.writeCharacteristicWithoutResponseForDevice(
      this.device.id, BLUEFLY_SERVICE_UUID, BLUEFLY_RX_CHAR_UUID, base64,
    )
  }

  /** Release the underlying native BleManager entirely — call only on app teardown. */
  destroy(): void {
    this.disconnect()
    this.manager.destroy()
  }
}
