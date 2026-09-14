/**
 * fetchWx — METAR/TAF fetch + METAR decoder.
 * Shared between web and native. Pass baseUrl='' for web (relative URL via
 * Vite proxy); pass API_BASE for native (absolute URL via adb reverse or prod).
 */

import { fetchWithRetry } from './fetchWithRetry'

export interface WxResult {
  metar: string | null
  taf:   string | null
}

export async function fetchWx(
  icao: string,
  baseUrl = '',
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<WxResult> {
  const url = `${baseUrl}/api/weather?icao=${encodeURIComponent(icao)}`
  // Retries transient network blips / 502-504 -- see fetchWithRetry.ts.
  const resp = await fetchWithRetry(url, { signal, headers })
  if (!resp.ok) throw new Error(`Weather fetch failed: HTTP ${resp.status}`)
  return resp.json() as Promise<WxResult>
}

// ── Nearest-station fallback ─────────────────────────────────────────────────
// Mirrors the "nearest available report" behaviour of public METAR/TAF sites:
// small/uncontrolled aerodromes rarely have their own AWOS/ATIS station, so
// when the requested ICAO has neither a METAR nor a TAF, fall through to the
// closest candidate that does. Sequential (not parallel) by design -- this
// only ever fires for the minority of airports with no local report, and
// sequential keeps it to one extra request at a time instead of a burst of
// N parallel /api/weather calls per popup open.

export interface WxStationCandidate {
  icao:   string
  /** Great-circle distance from the originally-requested aerodrome, NM. */
  distNm: number
}

export interface WxWithSource extends WxResult {
  /** ICAO the returned metar/taf actually came from -- equals the
   *  requested `icao` unless a fallback candidate had to be used. */
  sourceIcao: string
  /** Distance from the requested aerodrome to `sourceIcao`, NM -- null when
   *  the requested aerodrome's own report was used (no fallback needed). */
  distNm: number | null
}

export async function fetchWxNearest(
  icao: string,
  nearby: WxStationCandidate[],
  baseUrl = '',
  signal?: AbortSignal,
  headers?: Record<string, string>,
  maxCandidates = 6,
): Promise<WxWithSource> {
  // Wrapped in try/catch same as each candidate below -- some aerodromes in
  // the dataset carry a non-standard, longer-than-4-letter pseudo-ICAO for
  // small private strips without a real ICAO code (e.g. "ESTAGA" for
  // Trelleborg/Tågarp). The backend validates /^[A-Z]{4}$/ and 400s those,
  // which fetchWx() turns into a thrown Error -- previously that threw
  // straight out of fetchWxNearest entirely, skipping the fallback search
  // altogether and surfacing a bare "Weather unavailable" instead of the
  // nearest real station's actual METAR/TAF. A malformed/unfetchable OWN
  // icao should fall through to candidates exactly like a malformed/
  // unfetchable CANDIDATE icao already does, not abort the whole search.
  let own: WxResult | null = null
  try {
    own = await fetchWx(icao, baseUrl, signal, headers)
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
  }
  if (own && (own.metar || own.taf)) return { ...own, sourceIcao: icao, distNm: null }

  for (const cand of nearby.slice(0, maxCandidates)) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      const wx = await fetchWx(cand.icao, baseUrl, signal, headers)
      if (wx.metar || wx.taf) return { ...wx, sourceIcao: cand.icao, distNm: cand.distNm }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      // Candidate fetch failed (network/HTTP) -- try the next-nearest one.
    }
  }
  // Nothing found anywhere nearby -- report against the originally-requested
  // ICAO so callers show "no data" for the right identifier.
  return { metar: null, taf: null, sourceIcao: icao, distNm: null }
}

// ── METAR decoder ─────────────────────────────────────────────────────────────

export interface MetarDecoded {
  time:       string | null
  wind:       string | null
  vis:        string | null
  clouds:     string | null
  temp:       string | null
  qnh:        string | null
  wx:         string | null
  flightRule: 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null
  /** Numeric visibility in metres (9999 for CAVOK/10km+), null if unparseable.
   *  Exposed alongside the raw `.vis` token so callers doing per-metric
   *  colour-coding (e.g. a metar-taf.com-style tile grid) don't have to
   *  re-derive it from the raw token themselves. */
  visM:       number | null
  /** Numeric ceiling in feet (lowest BKN/OVC base), null if no ceiling
   *  (CAVOK/clear or only FEW/SCT reported) — same reasoning as `.visM`. */
  ceilingFt:  number | null
  /** Observation time resolved to an epoch ms against `referenceMs` (day-of-
   *  month + HH:MM from the DDHHMMZ group has no year/month of its own) --
   *  null if the raw METAR carried no recognisable time group. Powers an
   *  "Xm ago" freshness readout the way public METAR/TAF sites show next to
   *  the raw observation time. */
  obsMs:      number | null
}

/**
 * Resolves a METAR/TAF DDHHMMZ group (day-of-month + hour + minute, no
 * year/month of its own) against a reference timestamp, rolling into the
 * previous month if the day would otherwise land more than a few days in
 * the future -- mirrors parseTaf.ts's own resolveDayHour, duplicated here
 * (not imported) since parseTaf already depends on this file and importing
 * back would create a cycle for a ~10-line date calc.
 */
function resolveObsDayHourMin(day: number, hour: number, minute: number, referenceMs: number): number {
  const ref = new Date(referenceMs)
  let year = ref.getUTCFullYear()
  let month = ref.getUTCMonth()
  const candidate = Date.UTC(year, month, day, hour, minute)
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000
  if (candidate > referenceMs + THREE_DAYS_MS) {
    // e.g. observation day "28" evaluated on the 2nd of the next month.
    month -= 1
    if (month < 0) { month = 11; year -= 1 }
    return Date.UTC(year, month, day, hour, minute)
  }
  return candidate
}

export function decodeMetar(raw: string, referenceMs = Date.now()): MetarDecoded {
  const tokens = raw.split(/\s+/)

  const timeTok = tokens.find((t) => /^\d{6}Z$/.test(t))
  const time = timeTok ? timeTok.slice(2, 6).replace(/(\d{2})(\d{2})/, '$1:$2') + 'Z' : null
  const obsMs = timeTok
    ? resolveObsDayHourMin(parseInt(timeTok.slice(0, 2), 10), parseInt(timeTok.slice(2, 4), 10), parseInt(timeTok.slice(4, 6), 10), referenceMs)
    : null

  const windTok = tokens.find((t) => /^(\d{3}|VRB)\d{2}(G\d{2})?(KT|MPS)$/i.test(t))
  let wind: string | null = null
  if (windTok) {
    wind = /^000(00|KT|MPS)/i.test(windTok) ? 'CALM' : windTok.toUpperCase()
  }

  const visTok = tokens.find((t) => /^\d{4}$/.test(t) || /^\d+SM$/.test(t))
  const vis = visTok ?? null

  const cavok = tokens.includes('CAVOK')
  const cloudGroups = tokens.filter((t) => /^(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)?$/i.test(t))
  const clouds = cavok ? 'CAVOK' : cloudGroups.length > 0 ? cloudGroups.join(' ') : null

  const tempTok = tokens.find((t) => /^M?\d{2}\/M?\d{2}$/.test(t))
  const temp = tempTok ?? null

  const qnhTok = tokens.find((t) => /^[QA]\d{4}$/.test(t))
  const qnh = qnhTok ?? null

  const wxCodes = tokens.filter((t) =>
    /^[-+]?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS|TS|SH|FZ|MI|BC|DR|BL)(DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG)?$/.test(t),
  )
  const wx = wxCodes.length > 0 ? wxCodes.join(' ') : null

  let flightRule: MetarDecoded['flightRule'] = null
  const ceilingGroup  = cloudGroups.find((g) => /^(BKN|OVC)/.test(g))
  const ceilingFt     = ceilingGroup ? parseInt(ceilingGroup.slice(3, 6), 10) * 100 : null
  const visM          = cavok ? 9999 : visTok
    ? visTok.endsWith('SM') ? Math.round(parseFloat(visTok) * 1609) : parseInt(visTok, 10)
    : null
  if (cavok) {
    flightRule = 'VFR'
  } else {
    const ceilingHft = ceilingFt ?? 99999
    const visMForRule = visM ?? 99999
    if (ceilingHft < 500  || visMForRule < 1600) flightRule = 'LIFR'
    else if (ceilingHft < 1000 || visMForRule < 4800) flightRule = 'IFR'
    else if (ceilingHft < 3000 || visMForRule < 8000) flightRule = 'MVFR'
    else flightRule = 'VFR'
  }

  return { time, wind, vis, clouds, temp, qnh, wx, flightRule, visM, ceilingFt, obsMs }
}

// ── Chart-oriented structured parses of the same raw METAR groups ──────────
// decodeMetar() above deliberately keeps .wind/.clouds as raw METAR token
// strings (e.g. "27015G25KT", "BKN025 SCT100 OVC250") because that raw form
// is also displayed as plain text elsewhere (e.g. WeatherAlongRouteSheet).
// VerticalProfile/VirtualRadar's wind-arrow and cloud-layer rendering needs a
// structured shape instead — shared here (not duplicated per-platform) since
// it's pure parsing with zero UI/RN/DOM dependency, same as decodeMetar itself.

export interface ParsedWind {
  /** True heading the wind is blowing FROM, degrees. Null for VRB/CALM. */
  dirDeg: number | null
  speedKt: number
  gustKt: number | null
  variable: boolean
  calm: boolean
}

export function parseMetarWind(raw: string | null): ParsedWind | null {
  if (!raw) return null
  if (raw === 'CALM') return { dirDeg: null, speedKt: 0, gustKt: null, variable: false, calm: true }
  const m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/i.exec(raw)
  if (!m) return null
  const [, dirTok, spdTok, gustTok, unit] = m
  const toKt = (v: number) => unit.toUpperCase() === 'MPS' ? Math.round(v * 1.94384) : v
  return {
    dirDeg:   dirTok === 'VRB' ? null : parseInt(dirTok, 10),
    speedKt:  toKt(parseInt(spdTok, 10)),
    gustKt:   gustTok ? toKt(parseInt(gustTok, 10)) : null,
    variable: dirTok === 'VRB',
    calm:     false,
  }
}

export interface ParsedCloudLayer {
  cover: 'FEW' | 'SCT' | 'BKN' | 'OVC'
  baseFt: number
}

/** Lowest BKN/OVC layer base, or null if there isn't one (FEW/SCT-only or
 *  clear skies don't constitute a "ceiling" by definition). Factored out so
 *  parseTaf's hourly timeline builder can derive a ceiling from its own
 *  per-segment ParsedCloudLayer[] the same way decodeMetar does inline. */
export function ceilingFromClouds(clouds: ParsedCloudLayer[]): number | null {
  const layer = clouds.find((l) => l.cover === 'BKN' || l.cover === 'OVC')
  return layer ? layer.baseFt : null
}

/** Same VFR/MVFR/IFR/LIFR thresholds as decodeMetar's inline flight-rule
 *  logic, factored out for reuse by parseTaf's hourly timeline (each hour
 *  slice needs its own bucket, not just the current METAR's). */
export function flightRuleFromCeilingVis(
  ceilingFt: number | null,
  visM: number | null,
): 'VFR' | 'MVFR' | 'IFR' | 'LIFR' {
  const ceilingHft = ceilingFt ?? 99999
  const visMForRule = visM ?? 99999
  if (ceilingHft < 500 || visMForRule < 1600) return 'LIFR'
  if (ceilingHft < 1000 || visMForRule < 4800) return 'IFR'
  if (ceilingHft < 3000 || visMForRule < 8000) return 'MVFR'
  return 'VFR'
}

/** Returns [] for CAVOK/clear (correctly means "draw no layers"), not null,
 *  so call sites can .map() without an extra null-check. */
export function parseMetarClouds(raw: string | null): ParsedCloudLayer[] {
  if (!raw || raw === 'CAVOK') return []
  const groups = raw.split(/\s+/)
  const layers: ParsedCloudLayer[] = []
  for (const g of groups) {
    const m = /^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/i.exec(g)
    if (!m) continue
    layers.push({ cover: m[1].toUpperCase() as ParsedCloudLayer['cover'], baseFt: parseInt(m[2], 10) * 100 })
  }
  return layers
}
