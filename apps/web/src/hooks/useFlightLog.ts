/**
 * useFlightLog — auto-starts a GPS track log on takeoff, auto-stops on landing.
 *
 * Takeoff detection:  speedKts >= TAKEOFF_SPD_KTS  for TAKEOFF_CONFIRM_TICKS consecutive ticks
 * Landing detection:  speedKts <  LANDING_SPD_KTS  for LANDING_CONFIRM_TICKS consecutive ticks
 *                     AND at least MIN_FLIGHT_DURATION_MS has elapsed since takeoff
 *
 * Session behaviour (parkTimeoutMs > 0, default PARK_TIMEOUT_MS):
 *   After landing the log stays open ("taxiing" phase). If a new takeoff is detected
 *   before parkTimeoutMs elapses the same log continues — touch-and-go circuits are
 *   recorded as one session. When the aircraft remains parked until the timeout the
 *   log is closed automatically.
 *   Pass parkTimeoutMs = 0 to revert to per-leg splitting (a new log per T&G).
 *
 * Track points are accumulated in memory and flushed to RxDB every FLUSH_INTERVAL_MS.
 * A new document is created on the first takeoff of a session; the same document is
 * updated until the session closes.
 *
 * Returns `activeLogId` (string | null) so other components can know a log is recording.
 */

import { useState, useEffect, useRef } from 'react'
import { getDb, type TrackPoint } from '../db'
import type { GpsPosition } from '../utils/gpsTypes'
import type { FlyingMode } from '../utils/gpsTypes'

// ── Config ──────────────────────────────────────────────────────────────────
const TAKEOFF_SPD_KTS        = 30      // GS threshold for takeoff detection
const LANDING_SPD_KTS        = 20      // GS threshold for landing detection
const TAKEOFF_CONFIRM_TICKS  = 3       // consecutive ticks above takeoff threshold
const LANDING_CONFIRM_TICKS  = 8       // consecutive ticks below landing threshold
const MIN_FLIGHT_DURATION_MS = 30_000  // 30 s minimum flight to record
const FLUSH_INTERVAL_MS      = 10_000  // flush to RxDB every 10 s
const TRACK_INTERVAL_MS      = 1_000   // record a track point at most every 1 s
const PARK_TIMEOUT_MS        = 5 * 60 * 1000  // 5 min parked → close log; 0 = split per leg
const NM_PER_DEGREE_LAT      = 60.0

// ── Great-circle distance (fast approximation, adequate for incremental sum) ──
function quickDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * NM_PER_DEGREE_LAT
  const dLng = (lng2 - lng1) * NM_PER_DEGREE_LAT * Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

// ── UUID helper ──────────────────────────────────────────────────────────────
function newId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `log-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// ── Hook ─────────────────────────────────────────────────────────────────────
export function useFlightLog(
  position:       GpsPosition | null,
  flyingMode:     FlyingMode,
  aircraftId:     string,
  registration:   string,
  nearestIcao:    string | null,  // nearest aerodrome ICAO from useNearestFeature
  parkTimeoutMs:  number = PARK_TIMEOUT_MS,
  /** Takeoff / landed ground speeds (kt); from the aircraft profile via autoFlyThresholds(). */
  thr:            { takeoffKts: number; landedKts: number } = { takeoffKts: TAKEOFF_SPD_KTS, landedKts: LANDING_SPD_KTS },
  /** Set to true right before an AUTO stop of flying mode: a log parked between circuits is then left to the park timer. A manual stop (ref false) closes it at once. Reset by the hook. */
  deferCloseRef?: { current: boolean },
): { activeLogId: string | null; liveTrack: TrackPoint[] } {
  const [activeLogId, setActiveLogId] = useState<string | null>(null)
  const [liveTrack,   setLiveTrack]   = useState<TrackPoint[]>([])
  // Close out logs left in progress by a previous session (tab/app closed
  // mid-flight, so finishLog never ran). Runs once, before recording can start.
  useEffect(() => { void recoverOrphanedLogs() }, [])

  // Mutable refs — avoid re-creating the interval/effect on every position tick.
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
  }>({
    phase:         'idle',
    logId:         null,
    takeoffTicks:  0,
    landingTicks:  0,
    flightStartMs: 0,
    track:         [],
    lastTrackMs:   0,
    distanceNm:    0,
    maxAltFt:      0,
    prevLat:       0,
    prevLng:       0,
    departureIcao: '',
    flushTimer:    null,
    parkTimer:     null,
    dirty:         false,
  })

  // Reset everything when flying mode goes off.
  useEffect(() => {
    if (flyingMode === 'off') {
      const s = stateRef.current
      // Auto-stopped on landing while parked between circuits: leave the log open
      // and let the park timer close it, so a restart within the timeout continues
      // the same log instead of splitting it. A manual stop closes the log now.
      const defer = deferCloseRef?.current === true
      if (deferCloseRef) deferCloseRef.current = false
      if (defer && s.phase === 'taxiing' && s.logId && s.parkTimer && parkTimeoutMs > 0) return
      // If we were mid-flight (or parked with no park timer), close the log immediately.
      if ((s.phase === 'flying' || s.phase === 'taxiing') && s.logId) {
        finishLog(s.logId, s.track, s.distanceNm, s.maxAltFt, nearestIcao ?? '')
      }
      if (s.flushTimer) clearTimeout(s.flushTimer)
      if (s.parkTimer)  clearTimeout(s.parkTimer)
      stateRef.current = {
        phase:         'idle',
        logId:         null,
        takeoffTicks:  0,
        landingTicks:  0,
        flightStartMs: 0,
        track:         [],
        lastTrackMs:   0,
        distanceNm:    0,
        maxAltFt:      0,
        prevLat:       0,
        prevLng:       0,
        departureIcao: '',
        flushTimer:    null,
        parkTimer:     null,
        dirty:         false,
      }
      setActiveLogId(null)
      setLiveTrack([])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyingMode])

  // Process each position update.
  useEffect(() => {
    if (!position || flyingMode === 'off') return

    const s   = stateRef.current
    const now = Date.now()

    // ── Idle: new-session takeoff detection ──────────────────────────────
    if (s.phase === 'idle') {
      if (position.speedKts >= thr.takeoffKts) {
        s.takeoffTicks++
        if (s.takeoffTicks >= TAKEOFF_CONFIRM_TICKS) {
          const id = newId()
          s.phase         = 'flying'
          s.logId         = id
          s.flightStartMs = now
          s.track         = []
          s.lastTrackMs   = 0
          s.distanceNm    = 0
          s.maxAltFt      = position.altFt
          s.prevLat       = position.lat
          s.prevLng       = position.lng
          s.departureIcao = nearestIcao ?? ''
          s.dirty         = true
          setActiveLogId(id)
          createLog(id, now, aircraftId, registration, s.departureIcao)
        }
      } else {
        s.takeoffTicks = 0
      }
      return
    }

    // ── Taxiing: track on ground + T&G resumption ─────────────────────────
    // We keep recording track points during taxi so the ground roll is captured
    // in the same log. If speed climbs back above the takeoff threshold the park
    // timer is cancelled and the existing log continues seamlessly.
    if (s.phase === 'taxiing') {
      // Ground track recording
      if (s.prevLat !== 0 || s.prevLng !== 0) {
        s.distanceNm += quickDistNm(s.prevLat, s.prevLng, position.lat, position.lng)
      }
      s.prevLat  = position.lat
      s.prevLng  = position.lng
      s.maxAltFt = Math.max(s.maxAltFt, position.altFt)
      if (now - s.lastTrackMs >= TRACK_INTERVAL_MS) {
        s.track.push({
          lat:    position.lat,
          lng:    position.lng,
          altFt:  position.altFt,
          spdKts: position.speedKts,
          trkDeg: position.trackDeg,
          ts:     now,
        })
        s.lastTrackMs = now
        s.dirty       = true
        setLiveTrack([...s.track])
      }
      if (s.dirty && !s.flushTimer) {
        s.flushTimer = setTimeout(() => {
          if (s.logId && s.dirty) {
            flushLog(s.logId, s.track, s.distanceNm, s.maxAltFt)
            s.dirty      = false
            s.flushTimer = null
          }
        }, FLUSH_INTERVAL_MS)
      }
      // T&G resumption
      if (position.speedKts >= thr.takeoffKts) {
        s.takeoffTicks++
        if (s.takeoffTicks >= TAKEOFF_CONFIRM_TICKS) {
          if (s.parkTimer) { clearTimeout(s.parkTimer); s.parkTimer = null }
          s.phase         = 'flying'
          s.flightStartMs = now
          s.landingTicks  = 0
          s.prevLat       = position.lat
          s.prevLng       = position.lng
        }
      } else {
        s.takeoffTicks = 0
      }
      return
    }

    // ── Flying: track recording + landing detection ───────────────────────
    if (s.phase === 'flying') {
      if (s.prevLat !== 0 || s.prevLng !== 0) {
        s.distanceNm += quickDistNm(s.prevLat, s.prevLng, position.lat, position.lng)
      }
      s.prevLat  = position.lat
      s.prevLng  = position.lng
      s.maxAltFt = Math.max(s.maxAltFt, position.altFt)

      if (now - s.lastTrackMs >= TRACK_INTERVAL_MS) {
        s.track.push({
          lat:    position.lat,
          lng:    position.lng,
          altFt:  position.altFt,
          spdKts: position.speedKts,
          trkDeg: position.trackDeg,
          ts:     now,
        })
        s.lastTrackMs = now
        s.dirty       = true
        setLiveTrack([...s.track])
      }

      if (s.dirty && !s.flushTimer) {
        s.flushTimer = setTimeout(() => {
          if (s.logId && s.dirty) {
            flushLog(s.logId, s.track, s.distanceNm, s.maxAltFt)
            s.dirty      = false
            s.flushTimer = null
          }
        }, FLUSH_INTERVAL_MS)
      }

      // ── Landing detection ─────────────────────────────────────────────
      const flightDuration = now - s.flightStartMs
      if (
        position.speedKts < thr.landedKts &&
        flightDuration >= MIN_FLIGHT_DURATION_MS
      ) {
        s.landingTicks++
        if (s.landingTicks >= LANDING_CONFIRM_TICKS) {
          if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null }

          if (parkTimeoutMs === 0) {
            // Option A — close immediately, split per leg.
            if (s.logId) {
              finishLog(s.logId, s.track, s.distanceNm, s.maxAltFt, nearestIcao ?? '')
              setActiveLogId(null)
            }
            s.logId        = null
            s.phase        = 'idle'
            s.takeoffTicks = 0
            s.landingTicks = 0
          } else {
            // Option B — stay open, start park timer.
            s.phase        = 'taxiing'
            s.takeoffTicks = 0
            s.landingTicks = 0
            const arrivalIcao    = nearestIcao ?? ''
            s.parkTimer = setTimeout(() => {
              const cs = stateRef.current
              if (cs.phase !== 'taxiing' || !cs.logId) return
              if (cs.flushTimer) { clearTimeout(cs.flushTimer) }
              finishLog(cs.logId, cs.track, cs.distanceNm, cs.maxAltFt, arrivalIcao)
              stateRef.current = {
                phase:         'idle',
                logId:         null,
                takeoffTicks:  0,
                landingTicks:  0,
                flightStartMs: 0,
                track:         [],
                lastTrackMs:   0,
                distanceNm:    0,
                maxAltFt:      0,
                prevLat:       0,
                prevLng:       0,
                departureIcao: '',
                flushTimer:    null,
                parkTimer:     null,
                dirty:         false,
              }
              setActiveLogId(null)
              setLiveTrack([])
            }, parkTimeoutMs)
          }
        }
      } else {
        s.landingTicks = 0
      }
    }
  // Intentionally only re-run on position changes; other values are stable refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, flyingMode])

  return { activeLogId, liveTrack }
}

// ── RxDB helpers (fire-and-forget) ───────────────────────────────────────────

async function createLog(
  id:           string,
  startedAt:    number,
  aircraftId:   string,
  registration: string,
  departureIcao: string,
): Promise<void> {
  try {
    const db = await getDb()
    await db.flight_logs.insert({
      id,
      startedAt,
      endedAt:       0,
      aircraftId,
      registration,
      trackJson:     '[]',
      departureIcao,
      arrivalIcao:   '',
      distanceNm:    0,
      maxAltFt:      0,
      updatedAt:     startedAt,
    })
  } catch { /* silently swallow — log is nice-to-have, not critical */ }
}

async function flushLog(
  id:         string,
  track:      TrackPoint[],
  distanceNm: number,
  maxAltFt:   number,
): Promise<void> {
  try {
    const db  = await getDb()
    const doc = await db.flight_logs.findOne(id).exec()
    if (!doc) return
    await doc.patch({
      trackJson:  JSON.stringify(track),
      distanceNm,
      maxAltFt,
      updatedAt:  Date.now(),
    })
  } catch { /* silently swallow */ }
}

async function finishLog(
  id:          string,
  track:       TrackPoint[],
  distanceNm:  number,
  maxAltFt:    number,
  arrivalIcao: string,
): Promise<void> {
  try {
    const db  = await getDb()
    const doc = await db.flight_logs.findOne(id).exec()
    if (!doc) return
    await doc.patch({
      endedAt:     Date.now(),
      trackJson:   JSON.stringify(track),
      distanceNm,
      maxAltFt,
      arrivalIcao,
      updatedAt:   Date.now(),
    })
  } catch { /* silently swallow */ }
}

/**
 * Finalize logs with endedAt === 0 from a previous session: end each at its
 * last track point; remove ones with no track. Sync then uploads them like any
 * completed log.
 */
async function recoverOrphanedLogs(): Promise<void> {
  try {
    const db   = await getDb()
    const docs = await db.flight_logs.find({ selector: { endedAt: 0 } }).exec()
    for (const doc of docs) {
      let track: TrackPoint[] = []
      try { track = JSON.parse(doc.trackJson || '[]') } catch { /* corrupt → empty */ }
      if (track.length === 0) { await doc.remove(); continue }
      await doc.patch({
        endedAt:   Math.max(track[track.length - 1].ts || 0, doc.startedAt + 1),
        updatedAt: Date.now(),
      })
    }
  } catch { /* best-effort */ }
}
