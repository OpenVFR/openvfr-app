/**
 * gpsAltitudeReference — is this device's raw GPS altitude above the WGS-84
 * ellipsoid (needs the geoid correction, ./geoid.ts) or already above mean
 * sea level? Decided by the platform by default and VERIFIED on the ground.
 *
 * Default: Android (and Android browsers) report ellipsoidal heights, iOS
 * reports altitude above sea level (see ./geoid.ts). If a future Android,
 * browser or location-library version changed that silently, correcting
 * anyway would put every GPS altitude 60-125 ft too LOW over the Nordics --
 * so the app checks it against ground truth:
 *
 *   While stationary on the ground with a good vertical fix, it collects
 *   samples of (raw GPS altitude - terrain elevation). Above the ellipsoid
 *   that difference is about the geoid height N (18-38 m here), above sea
 *   level about 0. The median of enough well-spaced samples tells them
 *   apart; anything in between stays undecided.
 *
 * The verdict is stored per environment (OS / browser / app version) and
 * re-checked when that changes; until then the platform default applies.
 * A verdict that contradicts the default is logged loudly: it means the
 * platform changed and ./geoid.ts's platform rule needs updating.
 *
 * Platform-free: the app calls initGpsAltitudeReference() once at startup
 * and feeds observeGroundSample() from its position + terrain hooks.
 */

import type { KeyValueStore } from './persistedCache'
import { geoidHeightM } from './geoid'

export type GpsAltitudeRef = 'ellipsoid' | 'msl'

export interface GpsAltitudeRefVerdict {
  ref: GpsAltitudeRef
  /** Environment the check ran in (see initGpsAltitudeReference). */
  environment: string
  checkedAt: string
  /** Median of (raw GPS altitude - terrain elevation), m. */
  medianOffsetM: number
  /** Geoid height where the samples were taken, m. */
  geoidM: number
  samples: number
}

export interface GroundSample {
  /** Raw GPS altitude as the platform reported it (m, not corrected). */
  rawAltM: number
  /** Platform's vertical accuracy estimate (m), if any. */
  altAccuracyM?: number | null
  /** Terrain / aerodrome elevation AMSL at the position (m). */
  groundElevM: number
  lat: number
  lng: number
  speedKts: number
  /** Epoch ms. */
  t: number
}

// ── Sampling / decision rules ────────────────────────────────────────────────
/** Only on the ground, essentially stationary (taxi pause, run-up, parked). */
const MAX_SPEED_KTS = 3
/** Skip fixes whose own vertical accuracy estimate is worse than this. */
const MAX_ALT_ACCURACY_M = 12
/** Successive GPS fixes are correlated: take at most one sample per this. */
const MIN_SAMPLE_SPACING_MS = 5000
/** Samples needed before deciding. */
const MIN_SAMPLES = 20
/** Only decidable where the geoid is clearly away from 0. */
const MIN_GEOID_M = 12
/** How close the median must be to N (ellipsoid) or 0 (msl). */
const TOLERANCE_M = 8
/** Samples farther than this from the running median are dropped as outliers. */
const OUTLIER_M = 40

const STORAGE_KEY = 'openvfr.gpsAltitudeReference'

/**
 * The decision for a set of offsets (raw - ground, m) at geoid height N.
 * Exported for tests.
 */
export function classifyOffsets(offsetsM: readonly number[], geoidM: number): { ref: GpsAltitudeRef | null; medianM: number } {
  if (offsetsM.length === 0) return { ref: null, medianM: NaN }
  const sorted = [...offsetsM].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const medianM = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  if (offsetsM.length < MIN_SAMPLES || Math.abs(geoidM) < MIN_GEOID_M) return { ref: null, medianM }
  const nearEllipsoid = Math.abs(medianM - geoidM) <= TOLERANCE_M
  const nearMsl = Math.abs(medianM) <= TOLERANCE_M
  if (nearEllipsoid && !nearMsl) return { ref: 'ellipsoid', medianM }
  if (nearMsl && !nearEllipsoid) return { ref: 'msl', medianM }
  return { ref: null, medianM }
}

// ── State ────────────────────────────────────────────────────────────────────
let platformDefault: GpsAltitudeRef = 'msl'
let environment = ''
let kv: KeyValueStore | null = null
let verdict: GpsAltitudeRefVerdict | null = null
let offsets: number[] = []
let geoidSum = 0
let lastSampleAt = -Infinity
const listeners = new Set<() => void>()

/**
 * Set the platform default (from ./geoid.ts gpsAltitudeIsEllipsoidal) and
 * load a stored verdict if it was made in the same environment, e.g.
 * `android 34 app 1.4.0` or a browser user agent. Call once at startup.
 */
export async function initGpsAltitudeReference(opts: {
  platformDefault: GpsAltitudeRef
  environment: string
  store?: KeyValueStore
}): Promise<void> {
  platformDefault = opts.platformDefault
  environment = opts.environment
  kv = opts.store ?? null
  verdict = null
  try {
    const raw = await kv?.getItem(STORAGE_KEY)
    const v = raw ? (JSON.parse(raw) as GpsAltitudeRefVerdict) : null
    if (v && v.environment === environment && (v.ref === 'ellipsoid' || v.ref === 'msl')) verdict = v
  } catch { /* unreadable: check again */ }
  notify()
}

/** Reference to apply to raw GPS altitudes now. */
export function gpsAltitudeReference(): GpsAltitudeRef {
  return verdict?.ref ?? platformDefault
}

/** For a settings / diagnostics line. */
export function gpsAltitudeReferenceStatus(): {
  ref: GpsAltitudeRef
  source: 'verified' | 'platform-default'
  platformDefault: GpsAltitudeRef
  verdict: GpsAltitudeRefVerdict | null
  pendingSamples: number
} {
  return { ref: gpsAltitudeReference(), source: verdict ? 'verified' : 'platform-default', platformDefault, verdict, pendingSamples: offsets.length }
}

export function subscribeGpsAltitudeReference(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function notify(): void {
  for (const fn of listeners) fn()
}

/**
 * Feed one real GPS fix with the terrain elevation under it. Ignored unless
 * stationary, accurate, well spaced and where the geoid height is known and
 * large; no-op once this environment has a verdict.
 */
export function observeGroundSample(s: GroundSample): void {
  if (verdict) return
  if (!(s.speedKts <= MAX_SPEED_KTS)) return
  if (s.altAccuracyM != null && !(s.altAccuracyM <= MAX_ALT_ACCURACY_M)) return
  if (!Number.isFinite(s.rawAltM) || !Number.isFinite(s.groundElevM)) return
  if (s.t - lastSampleAt < MIN_SAMPLE_SPACING_MS) return
  const n = geoidHeightM(s.lat, s.lng)
  if (n == null || Math.abs(n) < MIN_GEOID_M) return
  const offset = s.rawAltM - s.groundElevM
  if (offsets.length >= 5) {
    const median = classifyOffsets(offsets, n).medianM
    if (Math.abs(offset - median) > OUTLIER_M) return
  }
  lastSampleAt = s.t
  offsets.push(offset)
  geoidSum += n
  const geoidM = geoidSum / offsets.length
  const { ref, medianM } = classifyOffsets(offsets, geoidM)
  if (!ref) {
    // Never decided after many samples (e.g. the DEM is off here): start over.
    if (offsets.length >= MIN_SAMPLES * 3) { offsets = []; geoidSum = 0 }
    return
  }
  verdict = {
    ref, environment, checkedAt: new Date(s.t).toISOString(),
    medianOffsetM: Math.round(medianM * 10) / 10, geoidM: Math.round(geoidM * 10) / 10, samples: offsets.length,
  }
  offsets = []
  geoidSum = 0
  if (ref !== platformDefault) {
    console.warn(`[gps-altitude] this device's GPS altitude is ${ref === 'msl' ? 'already above mean sea level' : 'above the WGS-84 ellipsoid'}, ` +
      `not ${platformDefault === 'msl' ? 'sea level' : 'ellipsoidal'} as assumed for the platform (median offset ${verdict.medianOffsetM} m, geoid ${verdict.geoidM} m, ` +
      `${verdict.samples} samples, ${environment}). Using the measured reference; update gpsAltitudeIsEllipsoidal in @open-vfr/shared/geoid.`)
  }
  void Promise.resolve(kv?.setItem(STORAGE_KEY, JSON.stringify(verdict))).catch(() => {})
  notify()
}

/** Test-only reset. */
export function __resetGpsAltitudeReferenceForTests(): void {
  platformDefault = 'msl'; environment = ''; kv = null; verdict = null
  offsets = []; geoidSum = 0; lastSampleAt = -Infinity; listeners.clear()
}
