/**
 * Flight-log statistics derived from a recorded track, shared by web and native.
 *
 * Everything here is computed on read from the stored track, so it needs no
 * stored fields (and no schema migration). One log is one session: circuits,
 * touch-and-gos and quick turnarounds stay in the same log, and the detail
 * (flights, landings, touch-and-gos) is recovered from the track.
 */

export interface LogTrackPoint {
  altFt:  number
  spdKts: number
  /** Unix ms */
  ts:     number
}

export interface LogSpeedThresholds {
  takeoffKts: number
  landedKts:  number
}

export interface LogStats {
  /** Time spent moving at flying speed (takeoff to landing, summed over flights), ms. */
  airborneMs:   number
  /** Number of takeoff-to-landing segments in the session. */
  flights:      number
  /** Landings completed in the session (touch-and-gos included). */
  landings:     number
  /** Landings followed by a takeoff within TOUCH_AND_GO_MAX_MS. */
  touchAndGos:  number
  maxGsKts:     number
  /** Time-weighted mean ground speed while airborne; 0 when never airborne. */
  avgGsKts:     number
  maxAltFt:     number
  /** Recording gaps longer than GAP_MIN_MS (GPS loss, app suspended). */
  gapCount:     number
  largestGapMs: number
}

/** A ground phase shorter than this between two flights is a touch-and-go. */
export const TOUCH_AND_GO_MAX_MS = 60_000
/** Flying segments shorter than this are speed noise (a taxi burst), not flights. */
export const MIN_FLIGHT_MS = 30_000
/** Track sampled every 1 s; a longer hole is a recording gap. */
export const GAP_MIN_MS = 30_000
/** Parked points kept after the last moving point when trimming a log's tail. */
export const PARKED_TAIL_KEEP_MS = 15_000

interface Segment { startTs: number; endTs: number; endIdx: number }

function flyingSegments(track: LogTrackPoint[], thr: LogSpeedThresholds): Segment[] {
  const segs: Segment[] = []
  let start = -1
  for (let i = 0; i < track.length; i++) {
    const spd = track[i].spdKts
    if (start < 0) {
      if (spd >= thr.takeoffKts) start = i
    } else if (spd < thr.landedKts) {
      segs.push({ startTs: track[start].ts, endTs: track[i].ts, endIdx: i })
      start = -1
    }
  }
  // Still moving at the end of the track: the flight just has no landing yet.
  if (start >= 0) segs.push({ startTs: track[start].ts, endTs: track[track.length - 1].ts, endIdx: -1 })
  return segs.filter((s) => s.endTs - s.startTs >= MIN_FLIGHT_MS)
}

export function computeLogStats(track: LogTrackPoint[], thr: LogSpeedThresholds): LogStats {
  const segs = flyingSegments(track, thr)
  const landed = segs.filter((s) => s.endIdx >= 0)

  let touchAndGos = 0
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].endIdx >= 0 && segs[i + 1].startTs - segs[i].endTs < TOUCH_AND_GO_MAX_MS) touchAndGos++
  }

  let airborneMs = 0
  let weighted = 0
  let maxGs = 0
  let maxAlt = 0
  let gapCount = 0
  let largestGap = 0
  for (let i = 0; i < track.length; i++) {
    const p = track[i]
    if (Number.isFinite(p.spdKts)) maxGs = Math.max(maxGs, p.spdKts)
    if (Number.isFinite(p.altFt))  maxAlt = Math.max(maxAlt, p.altFt)
    if (i === 0) continue
    const dt = p.ts - track[i - 1].ts
    if (dt > GAP_MIN_MS) { gapCount++; largestGap = Math.max(largestGap, dt) }
  }
  for (const s of segs) {
    airborneMs += s.endTs - s.startTs
  }
  if (airborneMs > 0) {
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1], b = track[i]
      const inFlight = segs.some((s) => a.ts >= s.startTs && b.ts <= s.endTs)
      const dt = b.ts - a.ts
      if (inFlight && dt <= GAP_MIN_MS && Number.isFinite(a.spdKts)) weighted += a.spdKts * dt
    }
  }

  return {
    airborneMs,
    flights:      segs.length,
    landings:     landed.length,
    touchAndGos,
    maxGsKts:     maxGs,
    avgGsKts:     airborneMs > 0 ? weighted / airborneMs : 0,
    maxAltFt:     maxAlt,
    gapCount,
    largestGapMs: largestGap,
  }
}

/**
 * Drop the parked tail of a session: the points recorded while the aircraft sat
 * still waiting for the park timer to close the log. Keeps PARKED_TAIL_KEEP_MS of
 * ground roll after the last point at or above `landedKts`. Returns the track
 * unchanged when nothing moved (or there is nothing to trim).
 */
export function trimParkedTail<T extends LogTrackPoint>(track: T[], landedKts: number): T[] {
  let last = -1
  for (let i = track.length - 1; i >= 0; i--) {
    if (track[i].spdKts >= landedKts) { last = i; break }
  }
  if (last < 0) return track
  const cutoff = track[last].ts + PARKED_TAIL_KEEP_MS
  let end = last
  while (end + 1 < track.length && track[end + 1].ts <= cutoff) end++
  return end + 1 < track.length ? track.slice(0, end + 1) : track
}

/** "1h 05m" / "42m" / "<1m". */
export function formatLogDuration(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return '<1m'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

export interface LogMapPoint extends LogTrackPoint {
  lat: number
  lng: number
}

type LineFeature = {
  type: 'Feature'
  geometry: { type: 'LineString'; coordinates: [number, number][] }
  properties: { kind: 'track' | 'gap' }
}

/**
 * Map geometry for a viewed log: one solid `track` LineString per continuous
 * stretch, and a `gap` LineString bridging each recording gap (hole longer than
 * GAP_MIN_MS), so a GPS dropout is drawn dashed instead of as a believable line.
 */
export function trackToGeoJson(track: LogMapPoint[]): { type: 'FeatureCollection'; features: LineFeature[] } {
  const features: LineFeature[] = []
  let cur: [number, number][] = []
  const flush = () => {
    if (cur.length > 1) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: cur }, properties: { kind: 'track' } })
    cur = []
  }
  for (let i = 0; i < track.length; i++) {
    const p = track[i]
    if (i > 0 && p.ts - track[i - 1].ts > GAP_MIN_MS) {
      const a = track[i - 1]
      flush()
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [p.lng, p.lat]] },
        properties: { kind: 'gap' },
      })
    }
    cur.push([p.lng, p.lat])
  }
  flush()
  return { type: 'FeatureCollection', features }
}

export type LogPeriod = 'all' | '30d' | '90d' | 'year'
export const LOG_PERIODS: readonly LogPeriod[] = ['all', '30d', '90d', 'year']
export const LOG_PERIOD_LABEL: Record<LogPeriod, string> = { all: 'All', '30d': '30 days', '90d': '90 days', year: 'This year' }

/** Earliest startedAt (ms) included in `period`; 0 for 'all'. 'year' = since 1 Jan (local time). */
export function logPeriodStart(period: LogPeriod, now: number = Date.now()): number {
  const DAY = 86_400_000
  switch (period) {
    case '30d':  return now - 30 * DAY
    case '90d':  return now - 90 * DAY
    case 'year': return new Date(new Date(now).getFullYear(), 0, 1).getTime()
    default:     return 0
  }
}

export interface LogTotals {
  logs:       number
  airborneMs: number
  landings:   number
  distanceNm: number
}

/**
 * Sum over logs. Airborne time falls back to the recorded span when no flight
 * was detected, matching the list rows. Simulated logs are not flights and
 * are left out entirely.
 */
export function logTotals(items: { startedAt: number; endedAt: number; distanceNm: number; stats: LogStats | null; simulated?: boolean }[]): LogTotals {
  const real = items.filter((it) => it.simulated !== true)
  const t: LogTotals = { logs: real.length, airborneMs: 0, landings: 0, distanceNm: 0 }
  for (const it of real) {
    t.airborneMs += it.stats && it.stats.airborneMs > 0 ? it.stats.airborneMs : Math.max(0, it.endedAt - it.startedAt)
    t.landings   += it.stats?.landings ?? 0
    t.distanceNm += it.distanceNm
  }
  return t
}

/**
 * What a flight-log recorder does with one position fix (web and native
 * useFlightLog). `openLogSimulated`: null when no log is open, else whether
 * the open log is already marked simulated.
 *  - 'ignore': a simulated fix while "Log simulated flights" is off -- it
 *    never starts or extends a log.
 *  - 'mark':   record it, and first mark the open log simulated -- a log
 *    that received any simulated fix must never look like a real flight.
 *  - 'record': record it as is.
 */
export function simulatedFixAction(
  sim: { simulated: boolean; record: boolean },
  openLogSimulated: boolean | null,
): 'ignore' | 'mark' | 'record' {
  if (!sim.simulated) return 'record'
  if (!sim.record) return 'ignore'
  return openLogSimulated === false ? 'mark' : 'record'
}
