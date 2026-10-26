/**
 * useFlightLog (native) — auto-starts a GPS track log on takeoff, auto-stops on landing.
 *
 * Direct port of web's src/hooks/useFlightLog.ts, adapted from RxDB (`getDb()`,
 * `doc.patch()`) to native's AsyncStorage-backed `flightLogs` store
 * (`native/src/db/index.ts` — full read-modify-write array, no per-doc patch API).
 * Detection thresholds/timings and phase state machine are identical to web —
 * see web's useFlightLog.ts for the full behavioural writeup (this file omits
 * the repeated comments; only the RxDB→AsyncStorage adapter differs).
 */

import { useState, useEffect, useRef } from 'react'
import * as Crypto from 'expo-crypto'
import { trimParkedTail, simulatedFixAction } from '@open-vfr/shared/flightLogStats'
import { flightLogs as flightLogsDb } from '../db'
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
  nearestIcao:    string | null,
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
        finishLog(s.logId, s.track, s.distanceNm, s.maxAltFt, nearestIcao ?? '', thr.landedKts, s.simulated)
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
          const id = newId()
          s.phase = 'flying'; s.logId = id; s.flightStartMs = now
          s.track = []; s.lastTrackMs = 0; s.distanceNm = 0
          s.maxAltFt = position.altFt; s.prevLat = position.lat; s.prevLng = position.lng
          s.departureIcao = nearestIcao ?? ''; s.dirty = true
          s.simulated = sim.simulated
          setActiveLogId(id)
          createLog(id, now, aircraftId, registration, s.departureIcao, sim.simulated)
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
              finishLog(s.logId, s.track, s.distanceNm, s.maxAltFt, nearestIcao ?? '', thr.landedKts, s.simulated)
              setActiveLogId(null)
            }
            s.logId = null; s.phase = 'idle'; s.takeoffTicks = 0; s.landingTicks = 0
          } else {
            s.phase = 'taxiing'; s.takeoffTicks = 0; s.landingTicks = 0
            const arrivalIcao = nearestIcao ?? ''
            s.parkTimer = setTimeout(() => {
              const cs = stateRef.current
              if (cs.phase !== 'taxiing' || !cs.logId) return
              if (cs.flushTimer) clearTimeout(cs.flushTimer)
              finishLog(cs.logId, cs.track, cs.distanceNm, cs.maxAltFt, arrivalIcao, thr.landedKts, cs.simulated)
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

async function createLog(
  id: string, startedAt: number, aircraftId: string, registration: string, departureIcao: string,
  simulated: boolean,
): Promise<void> {
  try {
    await flightLogsDb.upsert({
      id, startedAt, endedAt: 0, aircraftId, registration,
      trackJson: '[]', departureIcao, arrivalIcao: '', distanceNm: 0, maxAltFt: 0,
      updatedAt: startedAt,
      ...(simulated ? { simulated: true } : {}),
    })
  } catch { /* silently swallow — log is nice-to-have, not critical */ }
}

async function patchLog(id: string, patch: Partial<FlightLogDocType>): Promise<void> {
  try {
    // Reads and writes only this log (runs every FLUSH_INTERVAL_MS in flight).
    await flightLogsDb.patch(id, patch)
  } catch { /* silently swallow */ }
}

// `simulated` is written with every flush/finish, not only once: a patch is
// read-modify-write, so a single fire-and-forget flag write could be lost to
// a concurrent flush that read the log before it.
const simFlag = (simulated: boolean): Partial<FlightLogDocType> => (simulated ? { simulated: true } : {})

async function flushLog(id: string, track: TrackPoint[], distanceNm: number, maxAltFt: number, simulated = false): Promise<void> {
  await patchLog(id, { trackJson: JSON.stringify(track), distanceNm, maxAltFt, updatedAt: Date.now(), ...simFlag(simulated) })
}

async function finishLog(
  id: string, track: TrackPoint[], distanceNm: number, maxAltFt: number, arrivalIcao: string,
  landedKts: number = LANDING_SPD_KTS,
  simulated = false,
): Promise<void> {
  // Drop the points recorded while parked waiting for the park timer, and end
  // the log at the last real movement instead of when the timer fired.
  const trimmed = trimParkedTail(track, landedKts)
  const endedAt = trimmed !== track && trimmed.length > 0 ? trimmed[trimmed.length - 1].ts : Date.now()
  await patchLog(id, {
    endedAt, trackJson: JSON.stringify(trimmed), distanceNm, maxAltFt, arrivalIcao,
    updatedAt: Date.now(), ...simFlag(simulated),
  })
}

/**
 * Close out logs left in progress (endedAt === 0) by a previous session — the
 * app was killed or closed mid-flight, so finishLog never ran. Call once at
 * startup, before any new recording can begin. Each orphan is ended at its last
 * recorded track point (falling back to its last update time); orphans with no
 * track at all are removed. Returns the logs that were finalized.
 */
export async function recoverOrphanedLogs(): Promise<FlightLogDocType[]> {
  const recovered: FlightLogDocType[] = []
  try {
    const all = await flightLogsDb.getAll()
    for (const log of all) {
      if (log.endedAt > 0) continue
      let track: TrackPoint[] = []
      try { track = JSON.parse(log.trackJson || '[]') } catch { /* corrupt → treat as empty */ }
      if (track.length === 0) { await flightLogsDb.delete(log.id); continue }
      const endedAt = Math.max(track[track.length - 1].ts || 0, log.startedAt + 1)
      const fixed: FlightLogDocType = { ...log, endedAt, updatedAt: Date.now() }
      await flightLogsDb.upsert(fixed)
      recovered.push(fixed)
    }
  } catch { /* best-effort */ }
  return recovered
}
