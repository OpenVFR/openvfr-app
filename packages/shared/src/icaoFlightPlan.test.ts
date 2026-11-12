import { describe, it, expect } from 'vitest'
import { fplAircraftItems, normaliseEquipment, normaliseIcaoType, isIcaoType, hasVhfRadio } from './icaoFlightPlan'

const base = { registration: 'se-abc', icaoType: 'c172', equipment: undefined, hasRadio: undefined, transponder: undefined, adsb: undefined, wakeCategory: undefined, colour: undefined, modeSHex: undefined }

describe('icao type', () => {
  it('normalises and validates 2 to 4 characters starting with a letter', () => {
    expect(normaliseIcaoType(' c-172 ')).toBe('C172')
    expect(isIcaoType('C172')).toBe(true)
    expect(isIcaoType('GYRO')).toBe(true)
    expect(isIcaoType('C')).toBe(false)
    expect(isIcaoType('1ABC')).toBe(false)
    expect(isIcaoType('ABCDE')).toBe(false)
  })
})

describe('normaliseEquipment', () => {
  it('orders letters as the form does and drops unknown and repeated ones', () => {
    expect(normaliseEquipment(['g', 'V', 'o', 'v', 'Q'])).toEqual(['G', 'O', 'V'])
  })
  it('lets N and S stand alone (N wins)', () => {
    expect(normaliseEquipment(['V', 'S'])).toEqual(['S'])
    expect(normaliseEquipment(['S', 'N', 'V'])).toEqual(['N'])
    expect(normaliseEquipment([])).toEqual([])
  })
})

describe('fplAircraftItems', () => {
  it('builds items 7, 9, 10 and 19 from a complete profile', () => {
    const i = fplAircraftItems({ ...base, equipment: ['G', 'V', 'Y'], transponder: 'S', adsb: 'B1', wakeCategory: 'L', colour: 'White with blue stripes', modeSHex: '4a1b2c' })
    expect(i).toMatchObject({ identification: 'SEABC', type: 'C172', wake: 'L', equipment: 'GVY', surveillance: 'SB1', colour: 'WHITE WITH BLUE STRIPES' })
    expect(i.other).toEqual(['REG/SEABC', 'CODE/4A1B2C', 'NAV/GPS'])
    expect(i.missing).toEqual([])
  })
  it('uses ZZZZ and TYP/ when the designator is not valid, and says what is missing', () => {
    const i = fplAircraftItems({ ...base, icaoType: 'x' })
    expect(i.type).toBe('ZZZZ')
    expect(i.wake).toBe('L')
    expect(i.missing.join(' | ')).toMatch(/ICAO type designator.*equipment.*transponder.*colour/)
    expect(fplAircraftItems({ ...base, icaoType: 'Mooney M20' }).other).toContain('TYP/MOONEYM20')
  })
  it('takes VHF from the old radio flag when no equipment is set', () => {
    expect(fplAircraftItems({ ...base, hasRadio: true }).equipment).toBe('V')
    expect(fplAircraftItems({ ...base, hasRadio: false }).equipment).toBe('N')
  })
  it('writes no transponder as N and ADS-B alone without N', () => {
    expect(fplAircraftItems({ ...base, transponder: 'none' }).surveillance).toBe('N')
    expect(fplAircraftItems({ ...base, transponder: 'none', adsb: 'B2' }).surveillance).toBe('B2')
    expect(fplAircraftItems({ ...base, transponder: 'C' }).surveillance).toBe('C')
  })
})

describe('equipment Z', () => {
  it('asks the pilot to say what it is instead of putting a placeholder in the message', () => {
    const i = fplAircraftItems({ ...base, equipment: ['V', 'Z'], transponder: 'C', colour: 'White' })
    expect(i.other.join(' ')).not.toMatch(/COM\/|DAT\//)
    expect(i.missing.join(' ')).toMatch(/equipment Z/)
  })
})

describe('hasVhfRadio', () => {
  it('follows the equipment letters, and the old flag when none are set', () => {
    expect(hasVhfRadio({ equipment: ['V', 'G'] })).toBe(true)
    expect(hasVhfRadio({ equipment: ['Y'] })).toBe(true)
    expect(hasVhfRadio({ equipment: ['S'] })).toBe(true)
    expect(hasVhfRadio({ equipment: ['N'] })).toBe(false)
    expect(hasVhfRadio({ equipment: ['G', 'O'] })).toBe(false)
    expect(hasVhfRadio({ equipment: [], hasRadio: true })).toBe(true)
    expect(hasVhfRadio({ equipment: ['N'], hasRadio: true })).toBe(false)
    expect(hasVhfRadio({})).toBeUndefined()
  })
})
