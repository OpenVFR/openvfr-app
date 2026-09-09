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

import { useMemo } from 'react'
import { pickBestAltitudeSource, type AltitudeSourceResult } from '@open-vfr/shared/baroAltitude'
import { useInternalBarometer } from './useInternalBarometer'
import { useNearestQnh } from './useNearestQnh'
import { useSettingsContext } from '../context/SettingsContext'
import { useVarioContext } from '../context/VarioContext'
import type { GpsPosition } from '../utils/gpsTypes'

export function useAltitudeSource(position: GpsPosition | null): AltitudeSourceResult {
  const { settings } = useSettingsContext()

  const internalBaro = useInternalBarometer(settings.useInternalBarometer)
  const nearestQnh    = useNearestQnh(position, settings.qnhAuto)
  const vario         = useVarioContext()

  const qnhHpa = settings.qnhAuto
    ? (nearestQnh.qnhHpa ?? settings.qnhHpa)
    : settings.qnhHpa

  const varioConnected = vario.status === 'connected' && vario.state != null

  return useMemo(() => pickBestAltitudeSource({
    gpsAltFt: position ? position.altFt : null,
    internalBaroPressureHpa:
      settings.useInternalBarometer && internalBaro.availability === 'available'
        ? internalBaro.pressureHpa
        : null,
    varioAltFt:   varioConnected ? vario.state!.baroAltitudeFt     : null,
    varioVsFtMin: varioConnected ? vario.state!.verticalSpeedFtMin : null,
    qnhHpa,
  }), [position, settings.useInternalBarometer, internalBaro.availability, internalBaro.pressureHpa, varioConnected, vario.state, qnhHpa])
}
