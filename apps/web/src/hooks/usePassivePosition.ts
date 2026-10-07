/**
 * Own position for the non-flying "Passive" location mode: a position dot
 * on the map, camera never moved by updates. Deliberately separate from
 * useGoFlying's GPS pipeline -- Passive must not start flight logging,
 * warnings or the screen wake lock (those stay Go-Flying-only).
 *
 * Only runs while `active`; the browser permission prompt therefore only
 * ever appears after an explicit tap on the locate button (or never, when
 * permission was already granted and startup auto-enables Passive).
 */
import { useEffect, useState } from 'react'

export interface PassivePosition {
  lat: number
  lng: number
  accuracyM: number
  /** Degrees true, only when moving (browsers report null when stationary). */
  headingDeg: number | null
  /** Ground speed in knots; null when the device doesn't report one. */
  speedKts: number | null
}

const LS_LAST = 'ovfr:lastPosition'

/** Last known own position, for opening the map there next time. */
export function readLastPosition(): { lat: number; lng: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(LS_LAST) ?? 'null') as { lat?: unknown; lng?: unknown } | null
    return v && typeof v.lat === 'number' && typeof v.lng === 'number' ? { lat: v.lat, lng: v.lng } : null
  } catch { return null }
}

export function usePassivePosition(active: boolean): { position: PassivePosition | null; denied: boolean } {
  const [position, setPosition] = useState<PassivePosition | null>(null)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    if (!active || !('geolocation' in navigator)) { setPosition(null); return }
    let lastSaved = 0
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setDenied(false)
        const pos = {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracyM: p.coords.accuracy,
          headingDeg: p.coords.heading !== null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null,
          speedKts: p.coords.speed !== null && Number.isFinite(p.coords.speed) ? p.coords.speed * 1.943844 : null,
        }
        setPosition(pos)
        // Throttled: a watch can fire every second.
        if (Date.now() - lastSaved > 60_000) {
          lastSaved = Date.now()
          localStorage.setItem(LS_LAST, JSON.stringify({ lat: pos.lat, lng: pos.lng }))
        }
      },
      (err) => { if (err.code === err.PERMISSION_DENIED) setDenied(true) },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [active])

  return { position, denied }
}

/** True when geolocation permission is already granted (no prompt needed). */
export async function geolocationAlreadyGranted(): Promise<boolean> {
  try {
    const r = await navigator.permissions?.query({ name: 'geolocation' as PermissionName })
    return r?.state === 'granted'
  } catch { return false }
}
