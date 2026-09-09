/**
 * blueflyVario — BlueFly Vario BLE protocol logic: NMEA-style checksum
 * validation, ASCII line-buffer framing (handles BLE notification
 * fragmentation), $BFX / $LK8EX1 sentence parsing, and outbound command
 * builders. Pure, platform-agnostic — all BLE I/O lives in the native-only
 * BlueFlyBleManager (native/src/utils/BlueFlyBleManager.ts).
 *
 * See native/docs/ble-vario-plan.md §1/§2 for the full design rationale.
 */

import { pressureToAltitudeFt } from './baroAltitude'

// ── Checksum ─────────────────────────────────────────────────────────────────

/**
 * Validate an NMEA-style sentence of the form `$...*CC` where CC is the
 * 2-digit uppercase hex XOR checksum of every character between `$` and `*`.
 */
export function validateChecksum(sentence: string): boolean {
  const dollar = sentence.indexOf('$')
  const star   = sentence.indexOf('*', dollar)
  if (dollar === -1 || star === -1 || star <= dollar + 1) return false

  const body     = sentence.slice(dollar + 1, star)
  const checksum = sentence.slice(star + 1, star + 3).toUpperCase()
  if (checksum.length !== 2) return false

  let xor = 0
  for (let i = 0; i < body.length; i++) xor ^= body.charCodeAt(i)

  return xor.toString(16).toUpperCase().padStart(2, '0') === checksum
}

/** Compute the 2-digit uppercase hex checksum for a sentence body (no $ or *). */
function computeChecksum(body: string): string {
  let xor = 0
  for (let i = 0; i < body.length; i++) xor ^= body.charCodeAt(i)
  return xor.toString(16).toUpperCase().padStart(2, '0')
}

// ── Line-buffer framing ──────────────────────────────────────────────────────

export type AppendChunkResult = {
  /** Complete lines extracted from buf + chunk, in order. */
  lines: string[]
  /** Leftover partial line to prepend to the next chunk. */
  rest: string
}

/**
 * Append a raw BLE notification chunk to a rolling buffer and extract any
 * complete lines (terminated by \r\n or \n). Never assume one BLE
 * notification equals one complete sentence — the transport can fragment
 * or coalesce sentences arbitrarily.
 */
export function appendChunk(buf: string, chunk: string): AppendChunkResult {
  const combined = buf + chunk
  const parts    = combined.split(/\r\n|\n/)
  // split() always leaves the trailing partial (or empty string if the
  // buffer ended exactly on a terminator) as the last element.
  const rest  = parts.pop() ?? ''
  const lines = parts.filter((l) => l.length > 0)
  return { lines, rest }
}

/**
 * Parse a raw-mode ($BOM 0) sentence: `PRS XXXXX` where XXXXX is pressure
 * in Pascals as an uppercase hex integer, at the device's native 50 Hz rate.
 * Not NMEA-framed (no $...*checksum) — no checksum to validate.
 */
export function parsePrsRaw(line: string): number | null {
  const match = /^PRS\s+([0-9A-Fa-f]+)$/.exec(line.trim())
  if (!match) return null
  const pressurePa = parseInt(match[1], 16)
  return Number.isFinite(pressurePa) ? pressurePa : null
}

// ── Sentence types ───────────────────────────────────────────────────────────

export type BfxSentence = {
  pressurePa:   number
  varioCms:     number
  tempC:        number
  batteryPct:   number
  pitotDiffPa:  number
  batteryVolts: number
}

export type Lk8ex1Sentence = {
  pressurePa: number
  varioMs:    number
  tempC:      number
  batteryPct: number
}

/**
 * Parse a $BFX sentence:
 * $BFX,pressurePa,vario_cms,tempC,batteryPct,pitotDiffPa,batteryVolts*checksum
 * Returns null if the sentence doesn't match, fails checksum, or has fields
 * that don't parse as numbers.
 */
export function parseBfx(line: string): BfxSentence | null {
  if (!line.startsWith('$BFX,')) return null
  if (!validateChecksum(line)) return null

  const star = line.indexOf('*')
  const body = line.slice(1, star === -1 ? undefined : star)
  const fields = body.split(',')
  if (fields[0] !== 'BFX' || fields.length < 7) return null

  const [, pressurePa, varioCms, tempC, batteryPct, pitotDiffPa, batteryVolts] = fields
  const nums = [pressurePa, varioCms, tempC, batteryPct, pitotDiffPa, batteryVolts].map(Number)
  if (nums.some((n) => Number.isNaN(n))) return null

  return {
    pressurePa:   nums[0],
    varioCms:     nums[1],
    tempC:        nums[2],
    batteryPct:   nums[3],
    pitotDiffPa:  nums[4],
    batteryVolts: nums[5],
  }
}

/**
 * Parse a $LK8EX1 sentence (fallback mode):
 * $LK8EX1,pressure,altitude,vario,temp,battery*CC
 * Field 2 (altitude) is ignored per spec — sentinel value 99999 means
 * "not provided"; altitude is instead derived from pressure via ISA/QNH.
 */
export function parseLk8ex1(line: string): Lk8ex1Sentence | null {
  if (!line.startsWith('$LK8EX1,')) return null
  if (!validateChecksum(line)) return null

  const star = line.indexOf('*')
  const body = line.slice(1, star === -1 ? undefined : star)
  const fields = body.split(',')
  if (fields[0] !== 'LK8EX1' || fields.length < 6) return null

  const [, pressure, , vario, temp, battery] = fields
  const nums = [pressure, vario, temp, battery].map(Number)
  if (nums.some((n) => Number.isNaN(n))) return null

  return {
    pressurePa: nums[0],
    varioMs:    nums[1],
    tempC:      nums[2],
    batteryPct: nums[3],
  }
}

// ── Unified state ────────────────────────────────────────────────────────────

export type VarioState = {
  pressurePa:        number
  baroAltitudeFt:     number
  verticalSpeedFtMin: number
  temperatureC:       number
  batteryPercent:     number
  batteryVolts:       number | null
  lastUpdated:        number
}

const MS_TO_FTMIN = 196.850394
const CMS_TO_MS   = 0.01

export function bfxToVarioState(sentence: BfxSentence, qnhHpa: number, now = Date.now()): VarioState {
  return {
    pressurePa:         sentence.pressurePa,
    baroAltitudeFt:      pressureToAltitudeFt(sentence.pressurePa, qnhHpa),
    verticalSpeedFtMin: sentence.varioCms * CMS_TO_MS * MS_TO_FTMIN,
    temperatureC:       sentence.tempC,
    batteryPercent:     sentence.batteryPct,
    batteryVolts:       sentence.batteryVolts,
    lastUpdated:        now,
  }
}

export function lk8ex1ToVarioState(sentence: Lk8ex1Sentence, qnhHpa: number, now = Date.now()): VarioState {
  return {
    pressurePa:         sentence.pressurePa,
    baroAltitudeFt:      pressureToAltitudeFt(sentence.pressurePa, qnhHpa),
    verticalSpeedFtMin: sentence.varioMs * MS_TO_FTMIN,
    temperatureC:       sentence.tempC,
    batteryPercent:     sentence.batteryPct,
    batteryVolts:       null,
    lastUpdated:        now,
  }
}

// ── Outbound commands ────────────────────────────────────────────────────────

function buildCommand(code: string, arg?: string | number): string {
  const body = arg != null ? `${code} ${arg}` : code
  return `$${body}*${computeChecksum(body)}\r\n`
}

/** Set output mode: 0=raw, 1=LK8EX1, 6=$BFX extended NMEA. */
export function buildSetModeCmd(mode: number): string {
  return buildCommand('BOM', mode)
}

/** Set output rate divisor (e.g. 10 → 5 Hz from a 50 Hz base rate). */
export function buildSetRateCmd(divisor: number): string {
  return buildCommand('BOF', divisor)
}

/** Audible chirp for pilot feedback (frequency in Hz, duration in ms). */
export function buildChirpCmd(freqHz: number, durationMs: number): string {
  return buildCommand('BSD', `${freqHz} ${durationMs}`)
}

export function buildRequestSettingsCmd(): string {
  return buildCommand('BST')
}

export function buildFactoryResetCmd(): string {
  return buildCommand('RSX')
}
