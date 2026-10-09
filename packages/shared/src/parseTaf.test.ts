import { describe, it, expect } from 'vitest'
import { tafChangeIcaos } from './parseTaf'

const NOW = Date.UTC(2026, 9, 9, 12, 0)
// TAF issued 09 12:00, valid 09 12:00 -> 10 18:00 with a BECMG at 14:00 (2 h out).
const SOON = 'TAF ESSA 091100Z 0912/1018 24010KT 9999 SCT030 BECMG 0914/0916 30015KT'
const LATER = 'TAF ESSB 091100Z 0912/1018 24010KT 9999 SCT030 BECMG 1006/1008 30015KT'

describe('tafChangeIcaos', () => {
  it('lists only stations with a trend change inside the warning window', () => {
    expect(tafChangeIcaos([
      { icao: 'ESSA', taf: SOON },
      { icao: 'ESSB', taf: LATER },
      { icao: 'ESKN', taf: null },
    ], NOW)).toEqual(['ESSA'])
  })
})
