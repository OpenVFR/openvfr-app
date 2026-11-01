/**
 * trafficInfo — turns a tapped traffic feature (properties set by
 * hooks/useTraffic.ts) into the rows the generic FeaturePopup shows.
 * Same fields and wording as web's FeaturePopup traffic panel.
 */

import type { FeatureInfo } from '../components/FeaturePopup'

const CATEGORY_LABEL: Record<number, string> = {
  0: 'No info', 1: 'Light', 2: 'Small', 3: 'Large', 4: 'B757-class',
  5: 'Heavy', 6: 'High-perf', 7: 'Rotorcraft', 8: 'Glider',
  9: 'Lighter-than-air', 10: 'Parachutist', 11: 'Ultralight',
  12: 'Ultralight', 13: 'UAV', 14: 'Space vehicle',
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A feature from the traffic source: every one carries icao24 + iconId. */
export function isTrafficFeature(p: Record<string, unknown>): boolean {
  return typeof p.icao24 === 'string' && typeof p.iconId === 'string'
}

export function trafficFeatureInfo(p: Record<string, unknown>, lngLat: [number, number]): FeatureInfo {
  const icao24   = String(p.icao24 ?? '')
  const callsign = typeof p.callsign === 'string' && p.callsign ? p.callsign : null
  const onGround = p.onGround === true
  const altFt    = num(p.altFt)
  const relAltFt = num(p.relAltFt)
  const speedKts = num(p.speedKts)
  const trackDeg = num(p.trackDeg)
  const vertFpm  = num(p.vertFpm)
  const category = num(p.category)
  const ogn      = p.source === 'ogn'

  const vertArrow = vertFpm == null ? '' : vertFpm > 100 ? ' ↑' : vertFpm < -100 ? ' ↓' : ' →'
  const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toLocaleString()}`
  const rows: ({ label: string; value: string } | null)[] = [
    { label: 'Altitude', value: onGround ? 'On ground' : altFt != null ? `${altFt.toLocaleString()} ft${vertArrow}` : 'Unknown' },
    !onGround && relAltFt != null ? { label: 'Relative alt', value: `${signed(relAltFt)} ft` } : null,
    speedKts != null ? { label: 'Speed', value: `${speedKts} kt` } : null,
    trackDeg != null ? { label: 'Track', value: `${trackDeg}°` } : null,
    !onGround && vertFpm != null ? { label: 'Vert rate', value: `${signed(vertFpm)} fpm` } : null,
    category != null && category > 0 ? { label: 'Category', value: CATEGORY_LABEL[category] ?? `Cat ${category}` } : null,
    { label: 'Source', value: ogn ? 'FLARM (Open Glider Network)' : 'ADS-B (OpenSky Network)' },
  ]

  return {
    kind:     'traffic',
    name:     callsign ?? icao24.toUpperCase(),
    subtitle: callsign ? `ICAO ${icao24.toUpperCase()}` : 'Traffic',
    rows:     rows.filter((r): r is { label: string; value: string } => r !== null),
    canAddToRoute: false,
    lngLat,
  }
}
