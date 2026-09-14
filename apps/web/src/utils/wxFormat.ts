/**
 * wxFormat — shared METAR/TAF display formatting + per-metric colour tone.
 *
 * Factored out of AerodromePopup so TafTimeline's hourly table can use the
 * exact same wind/visibility text formatting and tone thresholds as the
 * current-conditions tile grid, instead of drifting out of sync with a
 * second copy (see docs/styling.md — avoid duplicating logic).
 */

import type { ParsedWind, ParsedCloudLayer, MetarDecoded } from '@open-vfr/shared/fetchWx'

export type TileTone = 'ok' | 'warn' | 'danger' | 'info'

// ── Per-metric colour bucket ─────────────────────────────────────────────────
// Mirrors decodeMetar's own VFR/MVFR/IFR/LIFR thresholds, but applied to one
// metric at a time (not the combined flight rule) so a tile/column reads at
// a glance for the thing it's actually showing.

export function visTone(visM: number | null): TileTone {
  if (visM == null) return 'info'
  if (visM < 1600) return 'danger'
  if (visM < 8000) return 'warn'
  return 'ok'
}

export function ceilingTone(ceilingFt: number | null): TileTone {
  if (ceilingFt == null) return 'ok' // no ceiling reported == clear/high overcast
  if (ceilingFt < 1000) return 'danger'
  if (ceilingFt < 3000) return 'warn'
  return 'ok'
}

export function windTone(wind: ParsedWind | null): 'ok' | 'warn' | 'danger' {
  if (!wind || wind.calm) return 'ok'
  const gust = wind.gustKt ?? wind.speedKt
  if (gust >= 30 || wind.speedKt >= 25) return 'danger'
  if (gust >= 20 || wind.speedKt >= 15) return 'warn'
  return 'ok'
}

// ── Text formatting ───────────────────────────────────────────────────────────

export function fmtVis(visM: number | null): string {
  if (visM == null) return '—'
  if (visM >= 9999) return '10 km+'
  if (visM >= 1000) return `${(visM / 1000).toFixed(visM % 1000 === 0 ? 0 : 1)} km`
  return `${visM} m`
}

export function fmtWind(wind: ParsedWind | null): string {
  if (!wind) return '—'
  if (wind.calm) return 'Calm'
  const dir = wind.variable ? 'VRB' : `${String(wind.dirDeg).padStart(3, '0')}°`
  const gust = wind.gustKt != null ? `G${wind.gustKt}` : ''
  return `${dir} ${wind.speedKt}${gust} kt`
}

const CLOUD_COVER_LABEL: Record<ParsedCloudLayer['cover'], string> = {
  FEW: 'Few clouds',
  SCT: 'Scattered clouds',
  BKN: 'Broken clouds',
  OVC: 'Overcast',
}

/** "38m ago" / "2h 05m ago" freshness readout for an observation time,
 *  same purpose as a public METAR/TAF site's age-since-observation label.
 *  Returns null for a future/unresolvable timestamp rather than showing a
 *  nonsensical negative age. */
export function fmtObsAge(obsMs: number | null, nowMs = Date.now()): string | null {
  if (obsMs == null) return null
  const deltaMin = Math.round((nowMs - obsMs) / 60_000)
  if (deltaMin < 0) return null
  if (deltaMin < 1) return 'just now'
  if (deltaMin < 60) return `${deltaMin}m ago`
  const h = Math.floor(deltaMin / 60)
  const m = deltaMin % 60
  return `${h}h ${String(m).padStart(2, '0')}m ago`
}

/** Plain-English translation of a decoded METAR, one short sentence per
 *  reported group -- mirrors a public METAR/TAF site's narrative summary,
 *  sized to fit this app's compact side-panel width (array of short lines
 *  instead of one long paragraph). */
export function metarNarrative(metar: MetarDecoded): string[] {
  const lines: string[] = []
  if (metar.wind === 'CALM') {
    lines.push('Wind is calm.')
  } else if (metar.wind) {
    const m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/i.exec(metar.wind)
    if (m) {
      const [, dir, spd, gust, unit] = m
      const dirText = dir === 'VRB' ? 'a variable direction' : `direction ${dir}°`
      const gustText = gust ? `, gusting ${gust}${unit.toLowerCase()}` : ''
      lines.push(`Wind is from ${dirText} at ${spd}${unit.toLowerCase()}${gustText}.`)
    }
  }
  if (metar.clouds === 'CAVOK') {
    lines.push('Ceiling and visibility OK — no significant cloud below 5,000 ft, visibility 10 km or more.')
  } else {
    if (metar.visM != null) {
      lines.push(metar.visM >= 9999 ? 'Visibility is 10 km or more.' : `Visibility is ${fmtVis(metar.visM)}.`)
    }
    if (metar.clouds) {
      const layers = metar.clouds.split(' ').map((g) => {
        const m = /^(FEW|SCT|BKN|OVC)(\d{3})/.exec(g)
        if (!m) return null
        const label = { FEW: 'few clouds', SCT: 'scattered clouds', BKN: 'broken clouds', OVC: 'overcast' }[m[1] as ParsedCloudLayer['cover']]
        return `${label} at ${parseInt(m[2], 10) * 100} ft`
      }).filter((s): s is string => !!s)
      if (layers.length > 0) lines.push(`Clouds: ${layers.join(', ')}.`)
    } else {
      lines.push('No significant cloud reported.')
    }
  }
  if (metar.wx) lines.push(`Weather: ${metar.wx}.`)
  if (metar.temp) {
    const [t, td] = metar.temp.split('/')
    lines.push(`Temperature ${t.replace('M', '-')}°C, dew point ${td.replace('M', '-')}°C.`)
  }
  if (metar.qnh) lines.push(`QNH ${metar.qnh.slice(1)} hPa.`)
  return lines
}

/** One headline phrase for a cloud layer set — picks the most significant
 *  (highest-cover) layer, same "one summary word" convention public METAR/TAF
 *  sites use per hour instead of listing every layer. */
export function skyLabel(clouds: ParsedCloudLayer[]): string {
  if (clouds.length === 0) return 'Clear'
  const rank: Record<ParsedCloudLayer['cover'], number> = { FEW: 1, SCT: 2, BKN: 3, OVC: 4 }
  const top = clouds.reduce((a, b) => (rank[b.cover] > rank[a.cover] ? b : a))
  return CLOUD_COVER_LABEL[top.cover]
}
