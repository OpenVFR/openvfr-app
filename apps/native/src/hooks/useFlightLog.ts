/**
 * useFlightLog (native) — auto-starts a GPS track log on takeoff, auto-stops on landing.
 *
 * Direct port of web's src/hooks/useFlightLog.ts, adapted from RxDB (`getDb()`,
 * `doc.patch()`) to native's AsyncStorage-backed `flightLogs` store
 * (`native/src/db/index.ts` — full read-modify-write array, no per-doc patch API).
 * Detection thresholds/timings and phase state machine are identical to web —
 * see web's useFlightLog.ts for the full behavioural writeup (this file omits
 * the repeated comments; only the RxDB→AsyncStorage adapter differs).
 *
 * Native differences: departure / arrival are named from the track ends
 * (aerodrome or saved place within 2 NM, @open-vfr/shared/flightLogAerodromes),
 * and a log a previous session left unfinished can be carried on by the next
 * takeoff close by (recoverOrphanedLogs, @open-vfr/shared/flightLogResume).
 */

import { logRouteJson, type FlightLogRoute } from '@open-vfr/shared/flightLogRoute'
import { useState, useEffect, useRef } from 'react'
import * as Crypto from 'expo-crypto'
import { trimParkedTail, simulatedFixAction } from '@open-vfr/shared/flightLogStats'
import { logPlaceNear, missingLogAerodromes, type LogAerodrome, type LogPlace } from '@open-vfr/shared/flightLogAerodromes'
import { canResumeLog, resumableUntil, type ResumePoint } from '@open-vfr/shared/flightLogResume'
import { isSyncableLog } from '@open-vfr/shared/cloudSyncRows'
import { getAerodromes } from './useNearbyFrequencies'
import { notifyLocalChange } from '../sync/cloudSync'
import { flightLogs as flightLogsDb, waypoints as userWaypointsDb } from '../db'
import type { TrackPoint, FlightLogDocType } from '../types/db'
import type { GpsPosition, FlyingMode } from '../utils/gpsTypes'

const TAKEOFF_SPD_KTS        = 30
const LANDING_SPD_KTS        = 20
const TAKEOFF_CONFIRM_TICKS  = 3
const LANDING_CONFIRM_TICKS  = 8
const MIN_FLIGHT_DURATION_MS = 30_000
const FLUSH_INTERVAL_MS      = 10_000
const TRACK_INTERVAL_MS      = 1_000
const PARK_TIMEOUT_MS        = 5 * 60 * 1000
const NM_PER_DEGREE_LAT      = 60.0

function quickDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * NM_PER_DEGREE_LAT
  const dLng = (lng2 - lng1) * NM_PER_DEGREE_LAT * Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

// user_flight_logs.id is a Postgres UUID column — must be a real UUID, not
// an arbitrary string, or every cloud push 400s ("invalid input syntax for
// type uuid"). Matches web's useFlightLog.ts newId().
function newId(): string {
  return Crypto.randomUUID()
}

export function useFlightLog(
  position:       GpsPosition | null,
  flyingMode:     FlyingMode,
  aircraftId:     string,
  registration:   string,
  parkTimeoutMs:  number = PARK_TIMEOUT_MS,
  /** Takeoff / landed ground speeds (kt); from the aircraft profile via autoFlyThresholds(). */
  thr:            { takeoffKts: number; landedKts: number } = { takeoffKts: TAKEOFF_SPD_KTS, landedKts: LANDING_SPD_KTS },
  /** Set to true right before an AUTO stop of flying mode: a log parked between circuits is then left to the park timer. A manual stop (ref false) closes it at once. Reset by the hook. */
  deferCloseRef?: { current: boolean },
  /** `simulated`: `position` comes from a simulator (Simulate mode, X-Plane /
   *  UDP / WebSocket input), not the device GPS. `record`: the "Record
   *  simulated flights" setting. Simulated positions are ignored unless
   *  `record` is on; a log that receives any simulated position is marked
   *  `simulated` (kept on the device, never synced, left out of totals). */
  simulation:     { simulated: boolean; record: boolean } = { simulated: false, record: false },
  /** The route planned at the moment (read when a log starts): stored with the log so its
   *  profile can show the planned level. A ref, so a route edit does not re-run the hook. */
  plannedRouteRef?: { current: FlightLogRoute | null },
): { activeLogId: string | null } {
  const [activeLogId, setActiveLogId] = useState<string | null>(null)

  const stateRef = useRef<{
    phase:         'idle' | 'flying' | 'taxiing'
    logId:         string | null
    takeoffTicks:  number
    landingTicks:  number
    flightStartMs: number
    track:         TrackPoint[]
    lastTrackMs:   number
    distanceNm:    number
    maxAltFt:      number
    prevLat:       number
    prevLng:       number
    departureIcao: string
    flushTimer:    ReturnType<typeof setTimeout> | null
    parkTimer:     ReturnType<typeof setTimeout> | null
    dirty:         boolean
    simulated:     boolean
  }>({
    phase: 'idle', logId: null, takeoffTicks: 0, landingTicks: 0, flightStartMs: 0,
    track: [], lastTrackMs: 0, distanceNm: 0, maxAltFt: 0, prevLat: 0, prevLng: 0,
    departureIcao: '', flushTimer: null, parkTimer: null, dirty: false, simulated: false,
  })

  useEffect(() => {
    if (flyingMode === 'off') {
      const s = stateRef.current
      // Auto-stopped on landing while parked between circuits: leave the log open
      // and let the park timer close it, so a restart within the timeout continues
      // the same log instead of splitting it. A manual stop closes the log now.
      const defer = deferCloseRef?.current === true
      if (deferCloseRef) deferCloseRef.current = false
      if (defer && s.phase === 'taxiing' && s.logId && s.parkTimer && parkTimeoutMs > 0) return
      if ((s.phase === 'flying' || s.phase === 'taxiing') && s.logId) {
        finishLog(s.logId, s.track, s.distanceNm, s.maxAltFt, thr.landedKts, s.simulated)
      }
      if (s.flushTimer) clearTimeout(s.flushTimer)
      if (s.parkTimer)  clearTimeout(s.parkTimer)
      stateRef.current = {
        phase: 'idle', logId: null, takeoffTicks: 0, landingTicks: 0, flightStartMs: 0,
        track: [], lastTrackMs: 0, distanceNm: 0, maxAltFt: 0, prevLat: 0, prevLng: 0,
        departureIcao: '', flushTimer: null, parkTimer: null, dirty: false, simulated: false,
      }
      setActiveLogId(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyingMode])

  const simulationRef = useRef(simulation)
  simulationRef.current = simulation

  useEffect(() => {
    if (!position || flyingMode === 'off') return
    const sim = simulationRef.current
    const simAction = simulatedFixAction(sim, stateRef.current.logId ? stateRef.current.simulated : null)
    if (simAction === 'ignore') return

    const s   = stateRef.current
    const now = Date.now()
    // A simulated position joining a log recorded so far from GPS taints it:
    // the logbook must never hold a real-looking flight with simulated track.
    if (simAction === 'mark' && s.logId) {
      s.simulated = true
      void patchLog(s.logId, { simulated: true })
    }

    if (s.phase === 'idle') {
      if (position.speedKts >= thr.takeoffKts) {
        s.takeoffTicks++
        if (s.takeoffTicks >= TAKEOFF_CONFIRM_TICKS) {
          // A log the app could not finish (closed or stopped between circuits
          // or in the air) and that ended close by, not long ago: carry it on.
          const resumed = takeResumableLog(position, now, thr.landedKts, parkTimeoutMs, sim.simulated)
          if (resumed) {
            s.phase = 'flying'; s.logId = resumed.id; s.flightStartMs = now
            s.track = resumed.track; s.lastTrackMs = 0; s.distanceNm = resumed.distanceNm
            s.maxAltFt = Math.max(resumed.maxAltFt, position.altFt); s.prevLat = position.lat; s.prevLng = position.lng
            s.departureIcao = resumed.departureIcao; s.dirty = true
            s.simulated = resumed.simulated
            setActiveLogId(resumed.id)
            return
          }
          // Anything else starts a new log; an unfinished one waiting is closed now.
          void closeResumableLog()
          const id = newId()
          s.phase = 'flying'; s.logId = id; s.flightStartMs = now
          s.track = []; s.lastTrackMs = 0; s.distanceNm = 0
          s.maxAltFt = position.altFt; s.prevLat = position.lat; s.prevLng = position.lng
          s.departureIcao = ''; s.dirty = true
          s.simulated = sim.simulated
          setActiveLogId(id)
          createLog(id, now, aircraftId, registration, { lat: position.lat, lng: position.lng }, sim.simulated, logRouteJson(plannedRouteRef?.current))
        }
      } else {
        s.takeoffTicks = 0
      }
      return
    }

    if (s.phase === 'taxiing') {
      if (s.prevLat !== 0 || s.prevLng !== 0) {
        s.distanceNm += quickDistNm(s.prevLat, s.prevLng, position.lat, position.lng)
      }
      s.prevLat = position.lat; s.prevLng = position.lng
      s.maxAltFt = Math.max(s.maxAltFt, position.altFt)
      if (now - s.lastTrackMs >= TRACK_INTERVAL_MS) {
        s.track.push({ lat: position.lat, lng: position.lng, altFt: position.altFt, spdKts: position.speedKts, trkDeg: position.trackDeg, ts: now })
        s.lastTrackMs = now; s.dirty = true
      }
      if (s.dirty && !s.flushTimer) {
        s.flushTimer = setTimeout(() => {
          if (s.logId && s.dirty) {
            flushLog(s.logId, s.track, s.distanceNm, s.maxAltFt, s.simulated)
            s.dirty = false; s.flushTimer = null
          }
        }, FLUSH_INTERVAL_MS)
      }
      if (position.speedKts >= thr.takeoffKts) {
        s.takeoffTicks++
        if (s.takeoffTicks >= TAKEOFF_CONFIRM_TICKS) {
          if (s.parkTimer) { clearTimeout(s.parkTimer); s.parkTimer = null }
          s.phase = 'flying'; s.flightStartMs = now; s.landingTicks = 0
          s.prevLat = position.lat; s.prevLng = position.lng
        }
      } else {
        s.takeoffTicks = 0
      }
      return
    }

    if (s.phase === 'flying') {
      if (s.prevLat !== 0 || s.prevLng !== 0) {
        s.distanceNm += quickDistNm(s.prevLat, s.prevLng, position.lat, position.lng)
      }
      s.prevLat = position.lat; s.prevLng = position.lng
      s.maxAltFt = Math.max(s.maxAltFt, position.altFt)

      if (now - s.lastTrackMs >= TRACK_INTERVAL_MS) {
        s.track.push({ lat: position.lat, lng: position.lng, altFt: position.altFt, spdKts: position.speedKts, trkDeg: position.trackDeg, ts: now })
        s.lastTrackMs = now; s.dirty = true
      }

      if (s.dirty && !s.flushTimer) {
        s.flushTimer = setTimeout(() => {
          if (s.logId && s.dirty) {
            flushLog(s.logId, s.track, s.distanceNm, s.maxAltFt, s.simulated)
            s.dirty = false; s.flushTimer = null
          }
        }, FLUSH_INTERVAL_MS)
      }

      const flightDuration = now - s.flightStartMs
      if (position.speedKts < thr.landedKts && flightDuration >= MIN_FLIGHT_DURATION_MS) {
        s.landingTicks++
        if (s.landingTicks >= LANDING_CONFIRM_TICKS) {
          if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null }

          if (parkTimeoutMs === 0) {
            if (s.logId) {
              finishLog(s.logId, s.track, s.distanceNm, s.maxAltFt, thr.landedKts, s.simulated)
              setActiveLogId(null)
            }
            s.logId = null; s.phase = 'idle'; s.takeoffTicks = 0; s.landingTicks = 0
          } else {
            s.phase = 'taxiing'; s.takeoffTicks = 0; s.landingTicks = 0
            s.parkTimer = setTimeout(() => {
              const cs = stateRef.current
              if (cs.phase !== 'taxiing' || !cs.logId) return
              if (cs.flushTimer) clearTimeout(cs.flushTimer)
              finishLog(cs.logId, cs.track, cs.distanceNm, cs.maxAltFt, thr.landedKts, cs.simulated)
              stateRef.current = {
                phase: 'idle', logId: null, takeoffTicks: 0, landingTicks: 0, flightStartMs: 0,
                track: [], lastTrackMs: 0, distanceNm: 0, maxAltFt: 0, prevLat: 0, prevLng: 0,
                departureIcao: '', flushTimer: null, parkTimer: null, dirty: false, simulated: false,
              }
              setActiveLogId(null)
                    }, parkTimeoutMs)
          }
        }
      } else {
        s.landingTicks = 0
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, flyingMode])

  return { activeLogId }
}

// ── AsyncStorage helpers (fire-and-forget) ─────────────────────────────────

/** Aerodromes and the user's saved places, for naming a log's ends. Null when neither could be read. */
async function namingData(timeoutMs = 20_000): Promise<{ aerodromes: LogAerodrome[]; places: LogPlace[] } | null> {
  const [aerodromes, places] = await Promise.all([
    getAerodromes(timeoutMs),
    userWaypointsDb.getAll().then(ws => ws.map(w => ({ name: w.name, lat: w.lat, lng: w.lng }))).catch(() => []),
  ])
  if (!aerodromes && places.length === 0) return null
  return { aerodromes: aerodromes ?? [], places }
}

async function createLog(
  id: string, startedAt: number, aircraftId: string, registration: string, at: { lat: number; lng: number },
  simulated: boolean,
  routeJson?: string,
): Promise<void> {
  try {
    // Departure: the aerodrome (or saved place) the takeoff roll is on. Short
    // wait: the log must exist before the first track save; a blank departure
    // is filled from the track when the log closes.
    const naming = await namingData(3_000)
    const departureIcao = naming ? logPlaceNear(at.lat, at.lng, naming.aerodromes, naming.places) : ''
    await flightLogsDb.upsert({
      id, startedAt, endedAt: 0, aircraftId, registration,
      trackJson: '[]', departureIcao, arrivalIcao: '', distanceNm: 0, maxAltFt: 0,
      updatedAt: startedAt,
      ...(simulated ? { simulated: true } : {}),
      ...(routeJson ? { routeJson } : {}),
    })
  } catch { /* silently swallow — log is nice-to-have, not critical */ }
}

async function patchLog(id: string, patch: Partial<FlightLogDocType>, quiet = false): Promise<void> {
  try {
    // Reads and writes only this log (runs every FLUSH_INTERVAL_MS in flight).
    await flightLogsDb.patch(id, patch, { quiet })
  } catch { /* silently swallow */ }
}

// `simulated` is written with every flush/finish, not only once: a patch is
// read-modify-write, so a single fire-and-forget flag write could be lost to
// a concurrent flush that read the log before it.
const simFlag = (simulated: boolean): Partial<FlightLogDocType> => (simulated ? { simulated: true } : {})

async function flushLog(id: string, track: TrackPoint[], distanceNm: number, maxAltFt: number, simulated = false): Promise<void> {
  // Quiet: the log lists need not reload every few seconds in flight.
  await patchLog(id, { trackJson: JSON.stringify(track), distanceNm, maxAltFt, updatedAt: Date.now(), ...simFlag(simulated) }, true)
}

async function finishLog(
  id: string, track: TrackPoint[], distanceNm: number, maxAltFt: number,
  landedKts: number = LANDING_SPD_KTS,
  simulated = false,
): Promise<void> {
  // Drop the points recorded while parked waiting for the park timer, and end
  // the log at the last real movement instead of when the timer fired.
  const trimmed = trimParkedTail(track, landedKts)
  const endedAt = trimmed !== track && trimmed.length > 0 ? trimmed[trimmed.length - 1].ts : Date.now()
  await patchLog(id, {
    endedAt, trackJson: JSON.stringify(trimmed), distanceNm, maxAltFt,
    updatedAt: Date.now(), ...simFlag(simulated),
  })
  // Arrival (and a departure not known at takeoff) from where the track ends:
  // only on the ground at an aerodrome or saved place. A second write, so the
  // log is closed at once even when the aerodrome data takes a while.
  await fillAerodromes(id, landedKts)
}

/** Fill a log's missing departure / arrival from its track ends. True when it changed the log. */
async function fillAerodromes(id: string, landedKts: number = LANDING_SPD_KTS): Promise<boolean> {
  try {
    const log = await flightLogsDb.get(id)
    if (!log || log.endedAt === 0 || (log.departureIcao && log.arrivalIcao)) return false
    const naming = await namingData()
    if (!naming) return false
    let track: TrackPoint[] = []
    try { track = JSON.parse(log.trackJson || '[]') } catch { return false }
    const patch = missingLogAerodromes(log, track, naming.aerodromes, landedKts, naming.places)
    if (!patch.departureIcao && !patch.arrivalIcao) return false
    await flightLogsDb.patch(id, { ...patch, updatedAt: Math.max(Date.now(), log.updatedAt + 1) })
    return true
  } catch {
    return false
  }
}

// ── Unfinished log from a previous session ─────────────────────────────────

/**
 * The log a previous session left unfinished that may still be carried on
 * (see @open-vfr/shared/flightLogResume): kept open until `until`, then
 * closed. One at a time, module-wide: the app records one log at a time.
 */
let resumable: {
  id: string; last: ResumePoint; until: number; landedKts: number
  track: TrackPoint[]; distanceNm: number; maxAltFt: number; departureIcao: string; simulated: boolean
} | null = null

/** Hand over the waiting unfinished log when this takeoff / fast fix continues it. */
function takeResumableLog(
  position: GpsPosition, now: number, landedKts: number, parkTimeoutMs: number, simulated: boolean,
): typeof resumable {
  const r = resumable
  if (!r || r.simulated !== simulated) return null
  if (!canResumeLog(r.last, { lat: position.lat, lng: position.lng, ts: now }, landedKts, parkTimeoutMs)) return null
  resumable = null
  return r
}

/**
 * Close the waiting unfinished log (its time is up, or a flight elsewhere
 * started): finished like a normal close, then uploaded. Returns it, or null
 * when none was waiting.
 */
export async function closeResumableLog(): Promise<FlightLogDocType | null> {
  const r = resumable
  if (!r) return null
  resumable = null
  try {
    const log = await flightLogsDb.get(r.id)
    if (!log || log.endedAt > 0) return null
    const trimmed = trimParkedTail(r.track, r.landedKts)
    const endedAt = Math.max(trimmed[trimmed.length - 1]?.ts ?? 0, log.startedAt + 1)
    await flightLogsDb.patch(r.id, { endedAt, trackJson: JSON.stringify(trimmed), updatedAt: Date.now() })
    await fillAerodromes(r.id, r.landedKts)
    const done = await flightLogsDb.get(r.id)
    if (done && isSyncableLog(done)) notifyLocalChange('user_flight_logs')
    return done ?? null
  } catch {
    return null
  }
}

/**
 * Logs left unfinished (endedAt === 0) by a previous session: the app was
 * closed or stopped before the log was finished (in the air, or parked while
 * the park timer ran; Android may stop the app in the background). Call once
 * at startup, before any new recording can begin.
 *
 * The most recent one that may still be carried on (canResumeLog: parked,
 * within the split timeout; or in the air, within 10 minutes) stays open:
 * a takeoff close to where it ended continues it. `resumeUntil` says when to
 * call closeResumableLog() if that does not happen. Every other one is closed
 * like a normal close (parked tail trimmed, ends at the last real movement);
 * one with no track at all is removed.
 *
 * Then every finished log still missing its departure or arrival gets them
 * from its track ends (missingLogAerodromes, aerodromes and saved places).
 * This repairs logs closed before this existed, and fills GPX imports.
 * `changed` = the logs to upload.
 */
export async function recoverOrphanedLogs(
  landedKts: number = LANDING_SPD_KTS,
  parkTimeoutMs: number = PARK_TIMEOUT_MS,
): Promise<{ changed: FlightLogDocType[]; resumeUntil: number | null }> {
  const changed = new Set<string>()
  const now = Date.now()
  try {
    const orphans: { log: FlightLogDocType; track: TrackPoint[] }[] = []
    for (const log of await flightLogsDb.getAll()) {
      if (log.endedAt > 0) continue
      if (resumable?.id === log.id) continue
      let track: TrackPoint[] = []
      try { track = JSON.parse(log.trackJson || '[]') } catch { /* corrupt → treat as empty */ }
      if (track.length === 0) { await flightLogsDb.delete(log.id); continue }
      orphans.push({ log, track })
    }
    // Newest first: only the latest flight can still be going on.
    orphans.sort((a, b) => b.track[b.track.length - 1].ts - a.track[a.track.length - 1].ts)
    for (const [i, { log, track }] of orphans.entries()) {
      const lastPt = track[track.length - 1]
      const last = { lat: lastPt.lat, lng: lastPt.lng, spdKts: lastPt.spdKts, ts: lastPt.ts }
      const until = resumableUntil(last, landedKts, parkTimeoutMs)
      if (i === 0 && !resumable && until > now) {
        resumable = {
          id: log.id, last, until, landedKts, track, distanceNm: log.distanceNm, maxAltFt: log.maxAltFt,
          departureIcao: log.departureIcao, simulated: log.simulated === true,
        }
        continue
      }
      const trimmed = trimParkedTail(track, landedKts)
      const endedAt = Math.max(trimmed[trimmed.length - 1].ts || 0, log.startedAt + 1)
      await flightLogsDb.upsert({ ...log, endedAt, trackJson: JSON.stringify(trimmed), updatedAt: Date.now() })
      changed.add(log.id)
    }
    const missing = (await flightLogsDb.getAll()).filter(l => l.endedAt > 0 && (!l.departureIcao || !l.arrivalIcao))
    for (const log of missing) if (await fillAerodromes(log.id, landedKts)) changed.add(log.id)
  } catch { /* best-effort */ }
  const out: FlightLogDocType[] = []
  for (const id of changed) { const d = await flightLogsDb.get(id); if (d) out.push(d) }
  return { changed: out, resumeUntil: resumable?.until ?? null }
}
