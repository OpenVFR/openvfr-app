/**
 * useAltitudeSource — the actual priority chooser combining GPS + (gated)
 * internal barometer + (Context-provided) BlueFly Vario state into one
 * altitude reading, via the shared pickBestAltitudeSource() (§1/§3b of
 * native/docs/ble-vario-plan.md).
 *
 * Priority: BlueFly BLE (tier 2, connected) > internal barometer (tier 1,
 * opt-in) > GPS (tier 0). Vario is never gated behind an opt-in — it's a
 * real external instrument, unlike the phone's internal sensor.
 */

import { useEffect, useMemo, useState } from 'react'
import { pickBestAltitudeSource, isVarioFresh, VARIO_STALE_MS, type AltitudeSourceResult } from '@open-vfr/shared/baroAltitude'
import { useInternalBarometer } from './useInternalBarometer'
import { useNearestQnh } from './useNearestQnh'
import { useFieldQnh } from './useFieldQnh'
import { resolveQnh } from '@open-vfr/shared/qnhResolve'
import { useSettingsContext } from '../context/SettingsContext'
import { useVarioContext } from '../context/VarioContext'
import type { GpsPosition } from '../utils/gpsTypes'

export function useAltitudeSource(position: GpsPosition | null): AltitudeSourceResult {
  const { settings } = useSettingsContext()

  const internalBaro = useInternalBarometer(settings.useInternalBarometer)
  const nearestQnh    = useNearestQnh(position, settings.qnhAuto)
  const vario         = useVarioContext()

  const baroActive = settings.useInternalBarometer && internalBaro.availability === 'available'

  // A connected vario that stops streaming (link up, no samples) must not
  // keep showing a frozen altitude with the BlueFly marker. Re-evaluated on a
  // 1 Hz tick, only while a vario is connected.
  const [nowMs, setNowMs] = useState(() => Date.now())
  const varioLinked = vario.status === 'connected' && vario.state != null
  useEffect(() => {
    if (!varioLinked) return
    const id = setInterval(() => setNowMs(Date.now()), Math.min(1_000, VARIO_STALE_MS))
    return () => clearInterval(id)
  }, [varioLinked])
  const varioConnected = varioLinked && isVarioFresh(vario.state!.lastUpdated, nowMs)

  // Offline / no-METAR fallback: calibrate against the field elevation while
  // parked, from the BlueFly's pressure when connected (more accurate than the
  // phone sensor), else the phone barometer.
  const fieldPressureHpa = varioConnected ? vario.state!.pressurePa / 100 : internalBaro.pressureHpa
  const fieldQnh = useFieldQnh(position, fieldPressureHpa, (baroActive || varioConnected) && settings.qnhAuto)

  const autoQnh = nearestQnh.qnhHpa ?? fieldQnh
  const { qnhHpa, calibrated: qnhCalibrated } = resolveQnh({
    auto: settings.qnhAuto, metarHpa: nearestQnh.qnhHpa, fieldHpa: fieldQnh, storedHpa: settings.qnhHpa,
  })

  // qnhCalibrated=false (auto mode, no METAR/field fix) makes the gauge flag the altitude.
  // Keep the BlueFly altitude on the same live QNH as the phone barometer.
  const { setLiveQnh } = vario
  useEffect(() => {
    setLiveQnh(settings.qnhAuto ? autoQnh : null)
    return () => setLiveQnh(null)
  }, [setLiveQnh, settings.qnhAuto, autoQnh])


  return useMemo(() => pickBestAltitudeSource({
    gpsAltFt: position ? position.altFt : null,
    internalBaroPressureHpa:
      settings.useInternalBarometer && internalBaro.availability === 'available'
        ? internalBaro.pressureHpa
        : null,
    internalBaroVsFtMin:
      settings.useInternalBarometer && internalBaro.availability === 'available'
        ? internalBaro.vsFtMin
        : null,
    varioAltFt:   varioConnected ? vario.state!.baroAltitudeFt     : null,
    varioVsFtMin: varioConnected ? vario.state!.verticalSpeedFtMin : null,
    qnhHpa,
    qnhCalibrated,
  }), [position, settings.useInternalBarometer, internalBaro.availability, internalBaro.pressureHpa, internalBaro.vsFtMin, varioConnected, vario.state, qnhHpa, qnhCalibrated])
}
