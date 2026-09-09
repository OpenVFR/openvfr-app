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
): { activeLogId: string | null; liveTrack: TrackPoint[] } {
  const [activeLogId, setActiveLogId] = useState<string | null>(null)
  const [liveTrack,   setLiveTrack]   = useState<TrackPoint[]>([])

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
    phase: 'idle', logId: null, takeoffTicks: 0, landingTicks: 0, flightStartMs: 0,
    track: [], lastTrackMs: 0, distanceNm: 0, maxAltFt: 0, prevLat: 0, prevLng: 0,
    departureIcao: '', flushTimer: null, parkTimer: null, dirty: false,
  })

  useEffect(() => {
    if (flyingMode === 'off') {
      const s = stateRef.current
      if ((s.phase === 'flying' || s.phase === 'taxiing') && s.logId) {
        finishLog(s.logId, s.track, s.distanceNm, s.maxAltFt, nearestIcao ?? '')
      }
      if (s.flushTimer) clearTimeout(s.flushTimer)
      if (s.parkTimer)  clearTimeout(s.parkTimer)
      stateRef.current = {
        phase: 'idle', logId: null, takeoffTicks: 0, landingTicks: 0, flightStartMs: 0,
        track: [], lastTrackMs: 0, distanceNm: 0, maxAltFt: 0, prevLat: 0, prevLng: 0,
        departureIcao: '', flushTimer: null, parkTimer: null, dirty: false,
      }
      setActiveLogId(null)
      setLiveTrack([])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyingMode])

  useEffect(() => {
    if (!position || flyingMode === 'off') return

    const s   = stateRef.current
    const now = Date.now()

    if (s.phase === 'idle') {
      if (position.speedKts >= TAKEOFF_SPD_KTS) {
        s.takeoffTicks++
        if (s.takeoffTicks >= TAKEOFF_CONFIRM_TICKS) {
          const id = newId()
          s.phase = 'flying'; s.logId = id; s.flightStartMs = now
          s.track = []; s.lastTrackMs = 0; s.distanceNm = 0
          s.maxAltFt = position.altFt; s.prevLat = position.lat; s.prevLng = position.lng
          s.departureIcao = nearestIcao ?? ''; s.dirty = true
          setActiveLogId(id)
          createLog(id, now, aircraftId, registration, s.departureIcao)
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
        setLiveTrack([...s.track])
      }
      if (s.dirty && !s.flushTimer) {
        s.flushTimer = setTimeout(() => {
          if (s.logId && s.dirty) {
            flushLog(s.logId, s.track, s.distanceNm, s.maxAltFt)
            s.dirty = false; s.flushTimer = null
          }
        }, FLUSH_INTERVAL_MS)
      }
      if (position.speedKts >= TAKEOFF_SPD_KTS) {
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
        setLiveTrack([...s.track])
      }

      if (s.dirty && !s.flushTimer) {
        s.flushTimer = setTimeout(() => {
          if (s.logId && s.dirty) {
            flushLog(s.logId, s.track, s.distanceNm, s.maxAltFt)
            s.dirty = false; s.flushTimer = null
          }
        }, FLUSH_INTERVAL_MS)
      }

      const flightDuration = now - s.flightStartMs
      if (position.speedKts < LANDING_SPD_KTS && flightDuration >= MIN_FLIGHT_DURATION_MS) {
        s.landingTicks++
        if (s.landingTicks >= LANDING_CONFIRM_TICKS) {
          if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null }

          if (parkTimeoutMs === 0) {
            if (s.logId) {
              finishLog(s.logId, s.track, s.distanceNm, s.maxAltFt, nearestIcao ?? '')
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
              finishLog(cs.logId, cs.track, cs.distanceNm, cs.maxAltFt, arrivalIcao)
              stateRef.current = {
                phase: 'idle', logId: null, takeoffTicks: 0, landingTicks: 0, flightStartMs: 0,
                track: [], lastTrackMs: 0, distanceNm: 0, maxAltFt: 0, prevLat: 0, prevLng: 0,
                departureIcao: '', flushTimer: null, parkTimer: null, dirty: false,
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, flyingMode])

  return { activeLogId, liveTrack }
}

// ── AsyncStorage helpers (fire-and-forget) ─────────────────────────────────

async function createLog(
  id: string, startedAt: number, aircraftId: string, registration: string, departureIcao: string,
): Promise<void> {
  try {
    await flightLogsDb.upsert({
      id, startedAt, endedAt: 0, aircraftId, registration,
      trackJson: '[]', departureIcao, arrivalIcao: '', distanceNm: 0, maxAltFt: 0,
      updatedAt: startedAt,
    })
  } catch { /* silently swallow — log is nice-to-have, not critical */ }
}

async function patchLog(id: string, patch: Partial<FlightLogDocType>): Promise<void> {
  try {
    const existing = await flightLogsDb.getAll().then(all => all.find(l => l.id === id))
    if (!existing) return
    await flightLogsDb.upsert({ ...existing, ...patch })
  } catch { /* silently swallow */ }
}

async function flushLog(id: string, track: TrackPoint[], distanceNm: number, maxAltFt: number): Promise<void> {
  await patchLog(id, { trackJson: JSON.stringify(track), distanceNm, maxAltFt, updatedAt: Date.now() })
}

async function finishLog(
  id: string, track: TrackPoint[], distanceNm: number, maxAltFt: number, arrivalIcao: string,
): Promise<void> {
  await patchLog(id, {
    endedAt: Date.now(), trackJson: JSON.stringify(track), distanceNm, maxAltFt, arrivalIcao,
    updatedAt: Date.now(),
  })
}
