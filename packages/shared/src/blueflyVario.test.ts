import { describe, it, expect } from 'vitest'
import {
  validateChecksum,
  appendChunk,
  parseBfx,
  parseLk8ex1,
  parsePrsRaw,
  bfxToVarioState,
  lk8ex1ToVarioState,
  buildSetModeCmd,
  buildSetRateCmd,
  buildChirpCmd,
} from './blueflyVario'

const VALID_BFX    = '$BFX,95400,150,18.5,87,1200,4.05*51'
const VALID_LK8EX1 = '$LK8EX1,95400,99999,150,18.5,87*17'

describe('validateChecksum', () => {
  it('accepts a correctly-checksummed $BFX sentence', () => {
    expect(validateChecksum(VALID_BFX)).toBe(true)
  })

  it('accepts a correctly-checksummed $LK8EX1 sentence', () => {
    expect(validateChecksum(VALID_LK8EX1)).toBe(true)
  })

  it('rejects a sentence with a corrupted checksum', () => {
    expect(validateChecksum('$BFX,95400,150,18.5,87,1200,4.05*00')).toBe(false)
  })

  it('rejects a sentence with corrupted body but original checksum', () => {
    expect(validateChecksum('$BFX,99999,150,18.5,87,1200,4.05*51')).toBe(false)
  })

  it('rejects malformed input missing $ or *', () => {
    expect(validateChecksum('BFX,95400*51')).toBe(false)
    expect(validateChecksum('$BFX,95400')).toBe(false)
  })
})

describe('appendChunk — line buffer framing', () => {
  it('extracts a single complete line with \\r\\n terminator', () => {
    const { lines, rest } = appendChunk('', VALID_BFX + '\r\n')
    expect(lines).toEqual([VALID_BFX])
    expect(rest).toBe('')
  })

  it('handles a sentence split across two chunks', () => {
    const half1 = VALID_BFX.slice(0, 10)
    const half2 = VALID_BFX.slice(10) + '\r\n'
    const step1 = appendChunk('', half1)
    expect(step1.lines).toEqual([])
    expect(step1.rest).toBe(half1)

    const step2 = appendChunk(step1.rest, half2)
    expect(step2.lines).toEqual([VALID_BFX])
    expect(step2.rest).toBe('')
  })

  it('extracts multiple complete lines from a single chunk', () => {
    const chunk = VALID_BFX + '\r\n' + VALID_LK8EX1 + '\n'
    const { lines, rest } = appendChunk('', chunk)
    expect(lines).toEqual([VALID_BFX, VALID_LK8EX1])
    expect(rest).toBe('')
  })

  it('keeps a trailing partial line with no terminator yet', () => {
    const chunk = VALID_BFX + '\r\n' + '$BFX,partial'
    const { lines, rest } = appendChunk('', chunk)
    expect(lines).toEqual([VALID_BFX])
    expect(rest).toBe('$BFX,partial')
  })
})

describe('parseBfx', () => {
  it('parses a valid $BFX sentence', () => {
    const result = parseBfx(VALID_BFX)
    expect(result).toEqual({
      pressurePa:   95400,
      varioCms:     150,
      tempC:        18.5,
      batteryPct:   87,
      pitotDiffPa:  1200,
      batteryVolts: 4.05,
    })
  })

  it('returns null for a sentence with bad checksum', () => {
    expect(parseBfx('$BFX,95400,150,18.5,87,1200,4.05*00')).toBeNull()
  })

  it('returns null for a non-$BFX sentence', () => {
    expect(parseBfx(VALID_LK8EX1)).toBeNull()
  })
})

describe('parseLk8ex1', () => {
  it('parses a valid $LK8EX1 sentence, ignoring the altitude field', () => {
    const result = parseLk8ex1(VALID_LK8EX1)
    expect(result).toEqual({
      pressurePa: 95400,
      varioMs:    150,
      tempC:      18.5,
      batteryPct: 87,
    })
  })

  it('returns null for a non-$LK8EX1 sentence', () => {
    expect(parseLk8ex1(VALID_BFX)).toBeNull()
  })
})

describe('bfxToVarioState / lk8ex1ToVarioState', () => {
  it('converts vario_cms to ft/min correctly', () => {
    const sentence = parseBfx(VALID_BFX)!
    const state = bfxToVarioState(sentence, 1013.25, 1000)
    // 150 cm/s = 1.5 m/s = 295.28 ft/min
    expect(state.verticalSpeedFtMin).toBeCloseTo(295.28, 1)
    expect(state.lastUpdated).toBe(1000)
    expect(state.batteryVolts).toBe(4.05)
  })

  it('converts LK8EX1 vario (already m/s) to ft/min, battery volts null', () => {
    const sentence = parseLk8ex1(VALID_LK8EX1)!
    const state = lk8ex1ToVarioState(sentence, 1013.25, 2000)
    // field value 150 here is treated as m/s per LK8EX1 spec (not cm/s)
    expect(state.verticalSpeedFtMin).toBeCloseTo(150 * 196.850394, 1)
    expect(state.batteryVolts).toBeNull()
  })
})

describe('command builders', () => {
  it('builds a correctly-checksummed set-mode command', () => {
    expect(buildSetModeCmd(6)).toBe('$BOM 6*56\r\n')
  })

  it('builds a correctly-checksummed set-rate command', () => {
    const cmd = buildSetRateCmd(10)
    expect(validateChecksum(cmd.trim())).toBe(true)
  })

  it('builds a correctly-checksummed chirp command', () => {
    const cmd = buildChirpCmd(400, 100)
    expect(validateChecksum(cmd.trim())).toBe(true)
  })
})

describe('parsePrsRaw', () => {
  it('parses a raw-mode PRS sentence (hex Pascals)', () => {
    // 0x17490 = 95376 Pa
    expect(parsePrsRaw('PRS 17490')).toBe(95376)
  })

  it('is case-insensitive on the hex digits', () => {
    expect(parsePrsRaw('PRS 1a2b3')).toBe(parseInt('1a2b3', 16))
  })

  it('tolerates surrounding whitespace / trailing \\r', () => {
    expect(parsePrsRaw('PRS 17490\r')).toBe(95376)
  })

  it('returns null for non-PRS lines', () => {
    expect(parsePrsRaw(VALID_BFX)).toBeNull()
    expect(parsePrsRaw('PRSABC')).toBeNull()
    expect(parsePrsRaw('PRS')).toBeNull()
    expect(parsePrsRaw('PRS xyz')).toBeNull()
  })
})
