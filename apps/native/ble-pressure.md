# AI Agent Specification: BlueFly Vario BLE Integration

## Objective
Implement native Bluetooth Low Energy (BLE) integration for the **BlueFly Vario** barometric pressure sensor in a React Native EFB application. The goal is to establish a robust, background-resilient connection, parse streaming ASCII telemetry, validate checksums, and convert barometric pressure into accurate QNH-adjustable altitude and vertical speed (vario) data.

---

## 1. System Architecture & BLE Requirements

### 1.1 Device GATT Specifications
The BlueFly Vario presents as a transparent serial-over-BLE bridge:
* **Service UUID:** `49535343-FE7D-4AE5-8FA9-9FAFD205E455`
* **TX Characteristic (Notify):** `49535343-1E4D-4BD9-BA61-23C647249616` (Device -> App)
* **RX Characteristic (Write Without Response):** `49535343-8841-43F4-A8D4-ECBE34729BB3` (App -> Device)
* **CCCD Descriptor:** `00002902-0000-1000-8000-00805F9B34FB`

### 1.2 Connection & Negotiation Sequence
To prevent data dropouts and lag at high tick rates, execute the following connection sequence exactly:
1. **Scan & Discover:** Filter by device name prefix `Bluefly` or Service UUID `49535343-FE7D-4AE5-8FA9-9FAFD205E455`.
2. **Connect:** Connect with auto-reconnect enabled for transient dropouts (`autoConnect: true` on Android).
3. **Request High MTU:** Request an ATT MTU of `512` bytes immediately upon connection (Android).
4. **Set Connection Priority:** Set high connection priority (connection interval ~7.5 ms).
5. **Settle Delay:** Wait 600 ms before service discovery on Android to avoid race conditions.
6. **Enable Notifications:** Write `0x01 0x00` to the CCCD Descriptor on the TX Characteristic.

---

## 2. Inbound Stream Framing & Buffer Management

### 2.1 ASCII Line Framing Protocol
The BLE link delivers a continuous, fragmented byte stream over the TX characteristic. **Do not assume one BLE notification equals one complete sentence**.
* Append incoming chunks to a rolling string/byte buffer.
* Extract lines using line terminators (`\r\n` or `\n`).
* Process extracted lines off the main UI thread to avoid JS bridge bottlenecks.

---

## 3. Data Telemetry Parsing & Formats

### 3.1 Recommended Sensor Telemetry Protocol
To balance firmware Kalman filtering with battery life and JS execution overhead, configure the BlueFly hardware to **Output Mode 6 (`$BFX`) at 5 Hz to 10 Hz**:
* Command to set Mode 6 (Extended NMEA): `$BOM 6*`
* Command to set Rate (Divisor 10 = 5 Hz output): `$BOF 10*`

#### `$BFX` Sentence Structure
`$BFX,pressurePa,vario_cms,tempC,batteryPct,pitotDiffPa,batteryVolts*checksum\r\n`

* **`pressurePa`**: Filtered barometric pressure in Pascals (unsigned integer).
* **`vario_cms`**: Vertical climb/sink rate in cm/s (signed integer; divide by `100.0` for m/s).
* **`tempC`**: Temperature in °C (float).
* **`batteryPct`**: Battery level percentage (0–100).
* **`batteryVolts`**: Hardware battery voltage (float).

### 3.2 Fallback Formats to Support
1. **LK8EX1 Mode (`$BOM 1*`):** `$LK8EX1,pressure,altitude,vario,temp,battery*CC`
   * *Note:* Ignore field 2 (`altitude` = `99999`); calculate altitude directly from `pressure` (Pa).
2. **Raw Mode (`$BOM 0*`):** `PRS XXXXX\n` (Raw hex Pascals at 50 Hz).
3. **Multiplexed GPS Pass-Through:** If the BlueFly has a GPS attached to UART1, parse standard NMEA (`$GPGGA`, `$GPRMC`, `$GNRMC`) interleaved on the same stream.

### 3.3 NMEA Checksum Validation
Validate all standard NMEA sentences (`$BFX`, `$BFV`, `$LK8EX1`) using an 8-bit XOR checksum over all characters between `$` and `*`:
`Checksum = XOR of ASCII codes from index($) + 1 to index(*) - 1`

---

## 4. Aeronautical Calculations (Altimetry & QNH)

### 4.1 International Standard Atmosphere (ISA) Formula
Convert barometric pressure P (in Pascals) to pressure altitude (metres) using the ISA model:
`altitude_m = 44301.59796 * (1 - (pressurePa / 101325)^0.190295)`

### 4.2 Local QNH Adjustment
Convert raw pressure altitude to local QNH barometric altitude in meters or feet:
`altitude_QNH_m = 44301.59796 * (1 - (pressurePa / (QNH_hPa * 100))^0.190295)`

---

## 5. Command Interface & Configuration

Commands are ASCII strings of the form `$<CODE> <arg>*`.

### 5.1 Common Outbound Commands
* **Request Settings:** `$BST*` (Device replies with `BFV`, `BST`, and `SET` positional array)
* **Set Output Mode:** `$BOM <0-6>*`
* **Set Output Divisor:** `$BOF <1-50>*` (e.g., `10` = 5 Hz output rate)
* **Factory Reset:** `$RSX*`
* **Audible Chirp (Audio Feedback):** `$BSD <freq_hz> <duration_ms>*` (e.g., `$BSD 400 100*`)

---

## 6. Implementation Checklist for AI Agent

- [ ] Create a dedicated BLE manager (`BlueFlyBleManager.ts`) using `react-native-ble-plx` or native modules.
- [ ] Implement the full connection sequence (MTU 512, High Priority, 600ms settle delay, CCCD enable).
- [ ] Build a robust ASCII line-buffer parser that handles packet fragmentation across notifications.
- [ ] Write standard NMEA checksum validation (`validateChecksum(sentence: string): boolean`).
- [ ] Implement ISA pressure-to-altitude conversions with dynamic QNH setting support.
- [ ] Parse `$BFX` and `$LK8EX1` sentences into a unified state store (e.g., Zustand/Redux/Context):
  ```typescript
  interface VarioState {
    pressurePa: number;
    baroAltitudeMeters: number;
    verticalSpeedMs: number;
    temperatureC: number;
    batteryPercent: number;
    batteryVolts: number;
    lastUpdated: number;
  }