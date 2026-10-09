/**
 * parseTaf — bounded TAF (Terminal Aerodrome Forecast) parsing for the
 * Virtual Radar chart's weather overlay.
 *
 * ── Scope note (read before extending) ──────────────────────────────────
 * A full "TAF period active at the aircraft's predicted position along the
 * route" overlay is NOT implemented here, and isn't a small addition on top
 * of this file — it needs a real ETD (estimated departure time) input to
 * convert route distance into wall-clock time, and no such field exists
 * anywhere in RouteDocType/LegOverride/AircraftProfileDocType today. That's
 * tracked separately in docs/todo.md as its own item (schema change + UI).
 *
 * What IS implemented: evaluate the TAF at the real current wall-clock time
 * (same as METAR is already used — "current best data", not a predicted
 * future state) via getActiveTafConditions(), for two uses in the chart:
 *   1. Fallback clouds/wind when no current METAR is available for a
 *      station (better than nothing, same "best available source" pattern
 *      used elsewhere in this app, e.g. baroAltitude.ts's altitude tiering).
 *   2. A "check the bulletin" warning flag when a real trend change
 *      (FM/BECMG — not TEMPO/PROB, which are temporary/probabilistic, not a
 *      prevailing-conditions change) is coming up soon — a nudge to check
 *      the full weather bulletin for changes to the forecast conditions,
 *      not a fully time-sliced overlay.
 *
 * ICAO Annex 3 TAF format handled: header (ICAO, issue DDHHMMZ, validity
 * DDHH/DDHH), base forecast group, then zero or more change groups
 * (FMDDHHMM / BECMG DDHH/DDHH / TEMPO DDHH/DDHH / PROB30|40 [TEMPO
 * DDHH/DDHH]). NOT handled: AMD/COR reissue semantics beyond skipping the
 * token, multiple simultaneous PROB+TEMPO wind shifts beyond the first, or
 * anything beyond wind+clouds (no visibility/weather-phenomena parsing —
 * matches parseMetarWind/parseMetarClouds' existing scope).
 */

import {
  parseMetarWind, parseMetarClouds, ceilingFromClouds, flightRuleFromCeilingVis,
  type ParsedWind, type ParsedCloudLayer,
} from './fetchWx'

export type TafPeriodKind = 'BASE' | 'FM' | 'BECMG' | 'TEMPO' | 'PROB30' | 'PROB40'

export interface TafPeriod {
  kind: TafPeriodKind
  /** Inclusive start, epoch ms. */
  fromMs: number
  /** Exclusive end, epoch ms (validity end for the last prevailing period). */
  toMs: number
  wind: ParsedWind | null
  clouds: ParsedCloudLayer[]
  /** Numeric visibility in metres for this segment (9999 for CAVOK/10km+),
   *  null if this segment's body carries no visibility group of its own
   *  (common for TEMPO/BECMG groups that only restate wind or clouds). */
  visM: number | null
}

/**
 * Resolves a TAF's day-of-month/hour/minute fields (which carry no
 * year/month) against a reference timestamp, rolling into next month if the
 * day would otherwise land more than a few days in the past — handles TAFs
 * issued right at a month boundary without needing the message's own issue
 * year/month (which TAF text never actually carries).
 */
function resolveDayHour(day: number, hour: number, minute: number, referenceMs: number): number {
  const ref = new Date(referenceMs)
  let year = ref.getUTCFullYear()
  let month = ref.getUTCMonth()
  const candidate = Date.UTC(year, month, day, hour, minute)
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000
  if (candidate < referenceMs - THREE_DAYS_MS) {
    month += 1
    if (month > 11) { month = 0; year += 1 }
    return Date.UTC(year, month, day, hour, minute)
  }
  if (candidate > referenceMs + 27 * 24 * 60 * 60 * 1000) {
    month -= 1
    if (month < 0) { month = 11; year -= 1 }
    return Date.UTC(year, month, day, hour, minute)
  }
  return candidate
}

/** Parses a "DDHH/DDHH" validity/change-window token into [fromMs, toMs]. */
function parseDdhhRange(tok: string, referenceMs: number): [number, number] | null {
  const m = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(tok)
  if (!m) return null
  const [, d1, h1, d2, h2] = m
  const from = resolveDayHour(parseInt(d1, 10), parseInt(h1, 10), 0, referenceMs)
  const to   = resolveDayHour(parseInt(d2, 10), parseInt(h2, 10), 0, referenceMs)
  return [from, to]
}

export function parseTaf(raw: string | null, referenceMs = Date.now()): TafPeriod[] | null {
  if (!raw) return null
  const tokens = raw.trim().split(/\s+/)

  // Header: TAF [AMD|COR] ICAO DDHHMMZ DDHH/DDHH
  let i = 0
  if (tokens[i] === 'TAF') i++
  if (tokens[i] === 'AMD' || tokens[i] === 'COR') i++
  if (/^[A-Z]{4}$/.test(tokens[i])) i++ // ICAO
  if (/^\d{6}Z$/.test(tokens[i])) i++   // issue time
  const validityTok = tokens[i]
  const validity = validityTok ? parseDdhhRange(validityTok, referenceMs) : null
  if (!validity) return null // not a recognisable TAF header — bail rather than guess
  i++
  const [validFromMs, validToMs] = validity

  // Split remaining tokens into segments at each change-group keyword.
  type RawSeg = { kind: TafPeriodKind; startTok: string | null; rangeTok: string | null; body: string[] }
  const segs: RawSeg[] = [{ kind: 'BASE', startTok: null, rangeTok: null, body: [] }]
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (/^FM\d{6}$/.test(t)) {
      segs.push({ kind: 'FM', startTok: t, rangeTok: null, body: [] })
    } else if (t === 'BECMG') {
      segs.push({ kind: 'BECMG', startTok: null, rangeTok: tokens[i + 1] ?? null, body: [] })
      if (tokens[i + 1]) i++
    } else if (t === 'TEMPO') {
      segs.push({ kind: 'TEMPO', startTok: null, rangeTok: tokens[i + 1] ?? null, body: [] })
      if (tokens[i + 1]) i++
    } else if (/^PROB(30|40)$/.test(t)) {
      const kind: TafPeriodKind = t === 'PROB30' ? 'PROB30' : 'PROB40'
      // PROBnn is often immediately followed by "TEMPO DDHH/DDHH" — fold
      // that range in here rather than starting a separate TEMPO segment,
      // since PROBnn alone (no TEMPO) has no time window of its own and
      // would otherwise never get one.
      if (tokens[i + 1] === 'TEMPO' && tokens[i + 2]) {
        segs.push({ kind, startTok: null, rangeTok: tokens[i + 2], body: [] })
        i += 2
      } else {
        segs.push({ kind, startTok: null, rangeTok: null, body: [] })
      }
    } else {
      segs[segs.length - 1].body.push(t)
    }
  }

  // Resolve each segment's [fromMs, toMs) and wind/clouds from its body tokens.
  const withTimes: { kind: TafPeriodKind; fromMs: number; toMs: number; body: string[] }[] = []
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s]
    let fromMs: number
    let toMs: number
    if (seg.kind === 'BASE') {
      fromMs = validFromMs
      // Provisional end — corrected below once we know the next segment's start.
      toMs = validToMs
    } else if (seg.kind === 'FM' && seg.startTok) {
      const m = /^FM(\d{2})(\d{2})(\d{2})$/.exec(seg.startTok)!
      fromMs = resolveDayHour(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), referenceMs)
      toMs = validToMs
    } else if (seg.rangeTok) {
      const range = parseDdhhRange(seg.rangeTok, referenceMs)
      if (!range) continue // malformed range token — skip this segment
      ;[fromMs, toMs] = range
    } else {
      continue // PROBnn with no TEMPO range and no other window — nothing to place on a timeline
    }
    withTimes.push({ kind: seg.kind, fromMs, toMs, body: seg.body })
  }

  // BASE and FM segments are sequential "prevailing conditions" — each one's
  // effective end is the next BASE/FM/BECMG's start (BECMG denotes a gradual
  // transition also ending the prior prevailing period). TEMPO/PROB keep
  // their own explicit window untouched (they overlay, not replace).
  const prevailingIdx = withTimes
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => p.kind === 'BASE' || p.kind === 'FM' || p.kind === 'BECMG')
    .sort((a, b) => a.p.fromMs - b.p.fromMs)
  for (let k = 0; k < prevailingIdx.length - 1; k++) {
    withTimes[prevailingIdx[k].idx].toMs = withTimes[prevailingIdx[k + 1].idx].fromMs
  }

  return withTimes.map(({ kind, fromMs, toMs, body }): TafPeriod => {
    const bodyStr = body.join(' ')
    const windTok = body.find((t) => /^(\d{3}|VRB)\d{2,3}(G\d{2,3})?(KT|MPS)$/i.test(t))
    const cloudToks = body.filter((t) => /^(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)?$/i.test(t) || t === 'CAVOK' || t === 'SKC' || t === 'NSC')
    const cavok = bodyStr.includes('CAVOK')
    // Visibility group: 4-digit metres (9999 = 10km+) or NNNSM (statute miles,
    // rare in TAF but same token shape decodeMetar already recognises in
    // METAR). CAVOK implies 10km+ without a separate group.
    const visTok = body.find((t) => /^\d{4}$/.test(t) || /^\d+SM$/i.test(t))
    const visM = cavok ? 9999 : visTok
      ? visTok.toUpperCase().endsWith('SM') ? Math.round(parseFloat(visTok) * 1609) : parseInt(visTok, 10)
      : null
    return {
      kind, fromMs, toMs,
      wind:   windTok ? parseMetarWind(windTok) : null,
      clouds: cloudToks.length > 0 ? parseMetarClouds(cloudToks.join(' ')) : [],
      visM,
    }
  })
}

export interface ActiveTafConditions {
  wind: ParsedWind | null
  clouds: ParsedCloudLayer[]
  visM: number | null
  source: TafPeriodKind
  /** Start of the next real prevailing-conditions change (FM/BECMG) after
   *  `atMs`, or null if none remain in the TAF's validity window. Not
   *  driven by TEMPO/PROB — those are temporary/probabilistic, not a
   *  change to the forecast trend worth a "go check the bulletin" nudge. */
  nextChangeMs: number | null
}

/**
 * Resolves what the TAF is actually forecasting at a given instant —
 * prevailing conditions (latest BASE/FM/BECMG whose window contains atMs),
 * overridden by a TEMPO/PROB period if one's window also contains atMs
 * (temporary conditions are the more operationally relevant thing to show
 * when active).
 */
export function getActiveTafConditions(periods: TafPeriod[], atMs: number): ActiveTafConditions | null {
  if (periods.length === 0) return null
  const prevailing = periods
    .filter((p) => p.kind === 'BASE' || p.kind === 'FM' || p.kind === 'BECMG')
    .filter((p) => atMs >= p.fromMs && atMs < p.toMs)
    .sort((a, b) => b.fromMs - a.fromMs)[0]
  if (!prevailing) return null

  const overlay = periods
    .filter((p) => p.kind === 'TEMPO' || p.kind === 'PROB30' || p.kind === 'PROB40')
    .find((p) => atMs >= p.fromMs && atMs < p.toMs)

  const nextChangeMs = periods
    .filter((p) => (p.kind === 'FM' || p.kind === 'BECMG') && p.fromMs > atMs)
    .reduce((min, p) => (min == null || p.fromMs < min ? p.fromMs : min), null as number | null)

  const active = overlay ?? prevailing
  return {
    wind:   active.wind ?? prevailing.wind,
    clouds: active.clouds.length > 0 ? active.clouds : prevailing.clouds,
    visM:   active.visM ?? prevailing.visM,
    source: active.kind,
    nextChangeMs,
  }
}

// ── Hourly timeline (for an hour-by-hour decoded forecast table) ──

export interface TafHourSlice {
  atMs:       number
  wind:       ParsedWind | null
  clouds:     ParsedCloudLayer[]
  visM:       number | null
  ceilingFt:  number | null
  flightRule: 'VFR' | 'MVFR' | 'IFR' | 'LIFR'
  /** Which period kind is driving this hour — lets the UI badge e.g. a
   *  TEMPO-covered hour differently from a plain prevailing hour. */
  source:     TafPeriodKind
}

/**
 * Slices a parsed TAF into one row per hour across its full validity window
 * (BASE/FM/BECMG span), each resolved via getActiveTafConditions the same
 * way the chart's "current instant" resolution works — just repeated at
 * `stepHours` intervals instead of evaluated once "now". This is what
 * powers an hour-by-hour forecast table (time / flight-rule / wind / vis /
 * ceiling per column), mirroring how public METAR/TAF sites present a TAF
 * as a timeline instead of raw period groups.
 */
export function buildTafTimeline(
  periods: TafPeriod[] | null,
  opts?: { stepHours?: number; maxSlices?: number },
): TafHourSlice[] {
  if (!periods || periods.length === 0) return []
  const stepMs    = (opts?.stepHours ?? 1) * 60 * 60 * 1000
  const maxSlices = opts?.maxSlices ?? 30

  const prevailing = periods.filter((p) => p.kind === 'BASE' || p.kind === 'FM' || p.kind === 'BECMG')
  if (prevailing.length === 0) return []
  const startMs = Math.min(...prevailing.map((p) => p.fromMs))
  const endMs   = Math.max(...prevailing.map((p) => p.toMs))

  const out: TafHourSlice[] = []
  // Align the first column to the next whole hour at/after the TAF's own
  // start (TAF validity almost always starts on the hour already, but this
  // keeps it correct if a real-world message ever doesn't).
  let t = Math.ceil(startMs / stepMs) * stepMs
  while (t < endMs && out.length < maxSlices) {
    const active = getActiveTafConditions(periods, t)
    if (active) {
      const ceilingFt = ceilingFromClouds(active.clouds)
      out.push({
        atMs: t,
        wind: active.wind,
        clouds: active.clouds,
        visM: active.visM,
        ceilingFt,
        flightRule: flightRuleFromCeilingVis(ceilingFt, active.visM),
        source: active.source,
      })
    }
    t += stepMs
  }
  return out
}

const DEFAULT_WARNING_WINDOW_MS = 3 * 60 * 60 * 1000 // 3h — arbitrary but matches typical pre-flight brief horizon

/**
 * One-call convenience for the chart: current METAR wind/clouds win when
 * present (observed beats forecast); TAF only fills in when there's no
 * METAR at all. Always also reports whether a real trend change (FM/BECMG)
 * is coming up soon, regardless of which source is being shown, so the
 * chart can raise a "go check the bulletin" warning even when the current
 * METAR looks fine right now.
 */
export function resolveStationWeather(opts: {
  metarWind: string | null
  metarClouds: string | null
  taf: string | null
  nowMs?: number
  warningWindowMs?: number
}): { wind: ParsedWind | null; clouds: ParsedCloudLayer[]; tafChangeSoon: boolean } {
  const nowMs = opts.nowMs ?? Date.now()
  const warningWindowMs = opts.warningWindowMs ?? DEFAULT_WARNING_WINDOW_MS
  const metarWind = parseMetarWind(opts.metarWind)
  const metarClouds = parseMetarClouds(opts.metarClouds)
  const periods = parseTaf(opts.taf, nowMs)
  const active = periods ? getActiveTafConditions(periods, nowMs) : null
  const tafChangeSoon = active?.nextChangeMs != null && active.nextChangeMs - nowMs <= warningWindowMs
  const hasMetar = metarWind != null || metarClouds.length > 0
  return {
    wind:   hasMetar ? metarWind   : (active?.wind ?? null),
    clouds: hasMetar ? metarClouds : (active?.clouds ?? []),
    tafChangeSoon,
  }
}

/**
 * ICAOs of stations whose TAF has a trend change (FM/BECMG) due soon, for the
 * route list's amber warning on those aerodromes.
 */
export function tafChangeIcaos(
  stations: { icao: string; taf: string | null }[],
  nowMs?: number,
): string[] {
  return stations.filter((s) => tafChangeSoon(s.taf, nowMs)).map((s) => s.icao)
}

/** True when this TAF has a trend change (FM/BECMG) due within the warning window. */
export function tafChangeSoon(taf: string | null | undefined, nowMs?: number): boolean {
  return !!taf && resolveStationWeather({ metarWind: null, metarClouds: null, taf, nowMs }).tafChangeSoon
}
