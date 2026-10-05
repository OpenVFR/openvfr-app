import { describe, it, expect } from 'vitest'
import {
  qnhTokenToHpa, isQnhResultStale, qnhStepNeedsReset, resolveQnh,
  QNH_MAX_AGE_MS, QNH_MAX_DIST_NM,
} from './qnhResolve'

describe('qnhTokenToHpa', () => {
  it('parses Q (hPa) tokens', () => expect(qnhTokenToHpa('Q1013')).toBe(1013))
  it('parses A (inHg) tokens', () => expect(qnhTokenToHpa('A2992')).toBeCloseTo(1013.2, 0))
  it('rejects garbled or implausible values', () => {
    expect(qnhTokenToHpa('Q0013')).toBeNull()
    expect(qnhTokenToHpa('Q9999')).toBeNull()
    expect(qnhTokenToHpa('A0992')).toBeNull()
    expect(qnhTokenToHpa('Qxyz')).toBeNull()
    expect(qnhTokenToHpa('1013')).toBeNull()
  })
})

describe('isQnhResultStale', () => {
  it('keeps a recent, nearby result', () => expect(isQnhResultStale(10 * 60_000, 20)).toBe(false))
  it('drops an old result', () => expect(isQnhResultStale(QNH_MAX_AGE_MS + 1, 0)).toBe(true))
  it('drops a distant result', () => expect(isQnhResultStale(0, QNH_MAX_DIST_NM + 1)).toBe(true))
})

describe('qnhStepNeedsReset', () => {
  it('ignores the very first value', () => expect(qnhStepNeedsReset(null, 1013)).toBe(false))
  it('ignores small drift', () => expect(qnhStepNeedsReset(1013, 1013.2)).toBe(false))
  it('resets on a real step, either direction', () => {
    expect(qnhStepNeedsReset(1013, 1008)).toBe(true)
    expect(qnhStepNeedsReset(1008, 1013)).toBe(true)
  })
})

describe('resolveQnh', () => {
  const base = { auto: true, metarHpa: null, fieldHpa: null, storedHpa: 1013.25 }
  it('prefers METAR over field calibration', () => {
    expect(resolveQnh({ ...base, metarHpa: 1020, fieldHpa: 1018 })).toEqual({ qnhHpa: 1020, calibrated: true })
  })
  it('uses field calibration when no METAR', () => {
    expect(resolveQnh({ ...base, fieldHpa: 1018 })).toEqual({ qnhHpa: 1018, calibrated: true })
  })
  it('falls back to stored value, flagged uncalibrated, in auto mode', () => {
    expect(resolveQnh(base)).toEqual({ qnhHpa: 1013.25, calibrated: false })
  })
  it('manual mode ignores live sources and counts as calibrated', () => {
    expect(resolveQnh({ ...base, auto: false, metarHpa: 1020, storedHpa: 1005 })).toEqual({ qnhHpa: 1005, calibrated: true })
  })
})
