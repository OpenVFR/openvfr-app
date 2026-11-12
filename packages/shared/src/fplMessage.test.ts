import { describe, it, expect } from 'vitest'
import { buildFpl, fplCoordinate, fplLevel, aftnText, EMPTY_ANSWERS, type FlightAnswers } from './fplMessage'
import type { AircraftProfileDocType } from './types'

const aircraft = {
  id: 'a', name: 'Skyhawk', registration: 'SE-ABC', icaoType: 'C172', category: 'SEP', cruiseAltFt: 3500, cruiseIas: 100, fuelBurnLhr: 38, maxFuelL: 150,
  taxiFuelL: 2, landingFuelL: 0, holdingMin: 0, contingencyPct: 0, diversionMin: 30, serviceCeilingFt: 0, rocSlFpm: 0, rocCeilingFpm: 0, climbIas: 0, climbFuelLhr: 0,
  descentFpm: 0, descentIas: 0, descentFuelLhr: 0, bestGlideIas: 0, glideRatio: 0, updatedAt: 0,
  equipment: ['V', 'G'], transponder: 'C', colour: 'White with blue stripes',
} as AircraftProfileDocType

const NOW = Date.UTC(2026, 10, 12, 9, 0)
const flight: FlightAnswers = { ...EMPTY_ANSWERS, eobt: new Date(Date.UTC(2026, 10, 12, 10, 30)), personsOnBoard: 2, pilotName: 'Test Pilot', pilotPhone: '+46701234567', alternate: 'ESSA' }
const route = [{ lat: 59.354, lng: 17.942, name: 'ESSB' }, { lat: 59.65, lng: 17.93, name: 'ESSB/LAVER' }, { lat: 58.6, lng: 16.9, name: 'ESSP' }]

describe('fplCoordinate', () => {
  it('writes degrees and minutes with hemispheres', () => {
    expect(fplCoordinate(59.35, 17.94)).toBe('5921N01756E')
    expect(fplCoordinate(-33.5, -70.25)).toBe('3330S07015W')
    expect(fplCoordinate(59.9999, 17.9999)).toBe('6000N01800E')
  })
})

describe('buildFpl', () => {
  it('builds the message for a complete flight', () => {
    const f = buildFpl({ nowMs: NOW, waypoints: route, legOverrides: [{}, {}], aircraft, flight })
    const lines = f.text.split('\n')
    expect(lines[0]).toBe('(FPL-SEABC-VG')
    expect(lines[1]).toBe('-C172/L-GV/C')
    expect(lines[2]).toBe('-ESSB1030')
    expect(lines[3]).toMatch(/^-N01\d\dVFR DCT 5939N01756E$/)
    expect(lines[4]).toMatch(/^-ESSP\d{4} ESSA$/)
    expect(lines[5]).toBe('-NAV/GPS DOF/261112)')
    expect(lines[5].endsWith(')')).toBe(true)
    expect(f.problems).toEqual([])
  })
  it('gives item 19 lines: endurance from fuel and burn, persons, colour, pilot', () => {
    const f = buildFpl({ nowMs: NOW, waypoints: route, legOverrides: [{}, {}], aircraft, flight: { ...flight, emergencyRadio: ['V', 'E'], survival: ['M'], jackets: ['L', 'F'], dinghies: { count: 1, capacity: 4, covered: true, colour: 'Yellow' } } })
    const s = f.supplementary.join('\n')
    expect(s).toContain('E/0357')       // 150 / 38 = 3.95 h = 3 h 57 min
    expect(s).toContain('P/002')
    expect(s).toContain('R/VE')
    expect(s).toContain('S/M')
    expect(s).toContain('J/LF')
    expect(s).toContain('D/01 004 C YELLOW')
    expect(s).toContain('A/WHITE WITH BLUE STRIPES')
    expect(s).toContain('C/TEST PILOT')
  })
  it('uses ZZZZ with DEP/ and DEST/ when an end is not an aerodrome, and says what is missing', () => {
    const f = buildFpl({
      nowMs: NOW,
      waypoints: [{ lat: 59.5, lng: 17.9, name: 'Cabin' }, { lat: 59.35, lng: 17.94, name: 'ESSB' }], legOverrides: [{}],
      aircraft: { ...aircraft, icaoType: 'x', registration: '' }, flight: { ...flight, pilotName: '', pilotPhone: '' },
    })
    expect(f.text).toContain('-ZZZZ1030')
    expect(f.text).toContain('DEP/5930N01754E')
    expect(f.text).toContain('(FPL-XXXXX-')
    expect(f.problems.join(' | ')).toMatch(/registration.*pilot in command.*phone/s)
  })
  it('flags type X without remarks and a bad alternate', () => {
    const f = buildFpl({ nowMs: NOW, waypoints: route, legOverrides: [{}, {}], aircraft, flight: { ...flight, type: 'X', alternate: 'ESS' } })
    const p = f.problems.join(' | ')
    expect(p).toMatch(/type of flight X/)
    expect(p).toMatch(/alternate/)
  })
  it('asks for a route first', () => {
    expect(buildFpl({ nowMs: NOW, waypoints: [], legOverrides: [], aircraft, flight }).text).toBe('')
  })
})

describe('levels', () => {
  const four = [{ lat: 59.354, lng: 17.942, name: 'ESSB' }, { lat: 59.5, lng: 17.5, name: 'A' }, { lat: 59.2, lng: 16.9, name: 'B' }, { lat: 58.6, lng: 16.9, name: 'ESSP' }]
  it('writes planned levels, with the new speed and level after the point where they change', () => {
    const f = buildFpl({ nowMs: NOW, waypoints: four, legOverrides: [{ altFt: 3500 }, { altFt: 3500 }, { altFt: 4500 }], aircraft, flight: { ...flight, levelMode: 'planned' } })
    const l = f.text.split('\n')[3]!
    expect(l).toMatch(/^-N01\d\dA035 DCT 5930N01730E 5912N01654E\/N01\d\dA045$/)
    expect(f.problems.join(' ')).not.toMatch(/flight levels/)
  })
  it('writes altitudes, never flight levels, and tells the pilot to convert levels above the transition altitude', () => {
    expect(fplLevel(4500)).toBe('A045')
    expect(fplLevel(6500)).toBe('A065')
    const f = buildFpl({ nowMs: NOW, waypoints: route, legOverrides: [{ altFt: 6500 }, { altFt: 6500 }], aircraft, flight: { ...flight, levelMode: 'planned' } })
    expect(f.text.split('\n')[3]).toMatch(/A065/)
    expect(f.text.split('\n')[3]).not.toMatch(/F065/)
    expect(f.problems.join(' ')).toMatch(/transition altitude.*flight level/)
    const low = buildFpl({ nowMs: NOW, waypoints: route, legOverrides: [{ altFt: 3500 }, { altFt: 3500 }], aircraft, flight: { ...flight, levelMode: 'planned' } })
    expect(low.problems.join(' ')).not.toMatch(/transition altitude/)
  })
  it('writes only the word VFR as the level, and a speed change only where the true airspeed changes', () => {
    const same = buildFpl({ nowMs: NOW, waypoints: four, legOverrides: [{ altFt: 3500 }, { altFt: 3500 }, { altFt: 3500 }], aircraft, flight })
    expect(same.text.split('\n')[3]).toMatch(/^-N01\d\dVFR DCT 5930N01730E 5912N01654E$/)
    const higher = buildFpl({ nowMs: NOW, waypoints: four, legOverrides: [{ altFt: 3500 }, { altFt: 3500 }, { altFt: 4500 }], aircraft, flight })
    expect(higher.text.split('\n')[3]).toMatch(/5912N01654E\/N01\d\dVFR$/)
  })
})

describe('checks before filing', () => {
  const run = (over: Partial<FlightAnswers>, ac: Partial<AircraftProfileDocType> = {}, nowMs = NOW) =>
    buildFpl({ nowMs, waypoints: route, legOverrides: [{}, {}], aircraft: { ...aircraft, ...ac } as AircraftProfileDocType, flight: { ...flight, ...over } }).problems.join(' | ')
  it('wants the off-block time between 5 minutes and 5 days ahead', () => {
    expect(run({ eobt: new Date(NOW + 2 * 60_000) })).toMatch(/off-block time/)
    expect(run({ eobt: new Date(NOW + 6 * 86_400_000) })).toMatch(/off-block time/)
    expect(run({})).not.toMatch(/off-block time/)
  })
  it('wants a phone number starting with + and the country code', () => {
    expect(run({ pilotPhone: '0701234567' })).toMatch(/must start with \+/)
    expect(run({ pilotPhone: '+46 70 123 45 67' })).not.toMatch(/phone/)
  })
  it('compares the endurance with the flight time', () => {
    expect(run({}, { maxFuelL: 5 })).toMatch(/endurance is less than the flight time/)
  })
  it('refuses the destination as the alternate and dinghies without capacity or colour', () => {
    expect(run({ alternate: 'ESSP' })).toMatch(/alternate cannot be the same/)
    expect(run({ dinghies: { count: 1, capacity: 0, covered: false, colour: '' } })).toMatch(/dinghies need a capacity and a colour/)
  })
  it('strips accents and characters the network does not carry', () => {
    expect(aftnText('Vit med blå ränder #1')).toBe('VIT MED BLA RANDER 1')
    const f = buildFpl({ nowMs: NOW, waypoints: route, legOverrides: [{}, {}], aircraft: { ...aircraft, colour: 'Röd & vit' } as AircraftProfileDocType, flight: { ...flight, pilotName: 'Åsa Öberg', remarks: 'Flyger över Mälaren' } })
    expect(f.supplementary.join('\n')).toContain('A/ROD VIT')
    expect(f.supplementary.join('\n')).toContain('C/ASA OBERG')
    expect(f.text).toContain('RMK/FLYGER OVER MALAREN')
  })
})

describe('item 15 and 18 conventions (ICAO Annex 2, Appendix 2)', () => {
  it('lists item 18 keywords in the standard order, and no REG/ when it equals the identification', () => {
    const f = buildFpl({ nowMs: NOW, waypoints: route, legOverrides: [{}, {}], aircraft: { ...aircraft, icaoType: 'ZZZZ', modeSHex: '4A1B2C' }, flight: { ...flight, remarks: 'test' } })
    const l = f.text.split('\n')[5]!
    expect(l).not.toContain('REG/')
    const keys = [...l.matchAll(/(?:^-| )([A-Z]+)\//g)].map(m => m[1])
    const order = ['NAV', 'DEP', 'DEST', 'DOF', 'TYP', 'CODE', 'RMK']
    expect(keys.filter(k => order.includes(k!))).toEqual(order.filter(k => keys.includes(k)))
  })
  it('puts DCT only where a point is not a coordinate', () => {
    const f = buildFpl({ nowMs: NOW, waypoints: route, legOverrides: [{}, {}], aircraft, flight })
    expect(f.text.split('\n')[3]).not.toMatch(/DCT DCT|\d[EW] DCT \d{4}[NS]/)
  })
})

describe('importText: item 19 inside the message', () => {
  it('puts item 19 before the closing bracket, A/ and C/ on their own lines', () => {
    const f = buildFpl({ nowMs: NOW, waypoints: route, legOverrides: [{}, {}], aircraft, flight: { ...flight, survival: ['M'], dinghies: { count: 1, capacity: 4, covered: true, colour: 'Yellow' } } })
    const l = f.importText.split('\n')
    expect(l.slice(0, 6)).toEqual(f.text.split('\n').slice(0, 5).concat(l[5]!))
    expect(l[6]).toMatch(/^-E\/\d{4} P\/002 S\/M D\/01 004 C YELLOW$/)
    expect(l[7]).toMatch(/^A\//)
    expect(l[l.length - 1]).toMatch(/^C\/.+\)$/)
    expect(f.importText.endsWith(')')).toBe(true)
    expect(f.importText.match(/\)/g)!.length).toBe(1)
  })
})

describe('persons not known and plain life jackets', () => {
  it('writes P/TBN and the remark JACKETS, and does not ask for a person count', () => {
    const f = buildFpl({ nowMs: NOW, waypoints: route, legOverrides: [{}, {}], aircraft, flight: { ...flight, personsUnknown: true, personsOnBoard: 0, jacketsPlain: true, remarks: '' } })
    const s = f.supplementary.join('\n')
    expect(s).toContain('P/TBN')
    expect(s).toContain('N/JACKETS')
    expect(f.importText).toMatch(/P\/TBN/)
    expect(f.problems.join(' ')).not.toMatch(/persons on board/)
  })
})
