/**
 * useInternalBarometer — wraps expo-sensors' Barometer for tier-1 altitude
 * source (native/docs/ble-vario-plan.md §3a). Pure hardware-availability +
 * raw-pressure probe — has no opinion on the opt-in safety gate; that lives
 * in useAltitudeSource.ts, which only reads this hook's output when
 * settings.useInternalBarometer is true.
 *
 * Android caveat: expo-sensors' Barometer only exposes raw pressure (hPa)
 * on Android — no relativeAltitude (iOS-only). Altitude is computed
 * ourselves via pressureToAltitudeFt() from raw pressure on both platforms
 * anyway, so this doesn't matter for our purposes.
 */

import { useEffect, useRef, useState } from 'react'
import { Barometer } from 'expo-sensors'
import type { EventSubscription } from 'expo-modules-core'
import { PhoneVarioFilter } from '@open-vfr/shared/phoneVario'

export type BaroAvailability = 'checking' | 'available' | 'unavailable'

export type UseInternalBarometerResult = {
  availability: BaroAvailability
  pressureHpa:  number | null
  /** Filtered vertical speed (ft/min); null until the filter has settled. */
  vsFtMin:      number | null
}

const UPDATE_INTERVAL_MS = 1_000  // 1 Hz — plenty for altitude display, avoids battery drain

export function useInternalBarometer(enabled: boolean): UseInternalBarometerResult {
  const [availability, setAvailability] = useState<BaroAvailability>('checking')
  const [pressureHpa, setPressureHpa]   = useState<number | null>(null)
  const [vsFtMin, setVsFtMin]           = useState<number | null>(null)
  const filterRef = useRef(new PhoneVarioFilter())
  const subscriptionRef = useRef<EventSubscription | null>(null)

  // Availability is checked regardless of `enabled` so the Settings opt-in
  // toggle can be greyed out on barometer-less devices even before the
  // pilot turns it on.
  useEffect(() => {
    let cancelled = false
    Barometer.isAvailableAsync().then((available) => {
      if (!cancelled) setAvailability(available ? 'available' : 'unavailable')
    })
    return () => { cancelled = true }
  }, [])

  // Only subscribe to live readings once both available AND opted in.
  useEffect(() => {
    if (!enabled || availability !== 'available') {
      subscriptionRef.current?.remove()
      subscriptionRef.current = null
      setPressureHpa(null)
      setVsFtMin(null)
      filterRef.current.reset()
      return
    }

    Barometer.setUpdateInterval(UPDATE_INTERVAL_MS)
    subscriptionRef.current = Barometer.addListener(({ pressure }) => {
      setPressureHpa(pressure)
      setVsFtMin(filterRef.current.update(pressure, Date.now()))
    })

    return () => {
      subscriptionRef.current?.remove()
      subscriptionRef.current = null
    }
  }, [enabled, availability])

  return { availability, pressureHpa, vsFtMin }
}
