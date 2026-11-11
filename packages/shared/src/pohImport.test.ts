import { describe, it, expect } from 'vitest'
import { buildPohPrompt, parsePohReply, parseFuelGrades, PohReplyError, POH_FIELDS } from './pohImport'

describe('buildPohPrompt', () => {
  it('names every field and asks for pages', () => {
    const p = buildPohPrompt()
    for (const k of POH_FIELDS) expect(p).toContain(`"${k}"`)
    expect(p).toContain('"pages"')
  })
})

describe('parsePohReply', () => {
  it('reads a plain JSON answer', () => {
    const r = parsePohReply('{"name":"Cessna 172S","icaoType":"c172","cruiseIas":122,"maxFuelL":201.5,"pages":{"cruiseIas":34,"name":"1-2"}}')
    expect(r.values).toEqual({ name: 'Cessna 172S', icaoType: 'C172', cruiseIas: '122', maxFuelL: '201.5' })
    expect(r.pages).toEqual({ cruiseIas: '34', name: '1-2' })
    expect(r.missing).toContain('fuelBurnLhr')
    expect(r.missing).not.toContain('cruiseIas')
    expect(r.warnings).toEqual({})
  })

  it('finds the object inside a code fence and prose', () => {
    const text = 'Here is the profile:\n```json\n{ "name": "DR400 {120}", "cruiseIas": "105 kt" }\n```\nCheck the values.'
    const r = parsePohReply(text)
    expect(r.values.name).toBe('DR400 {120}')
    expect(r.values.cruiseIas).toBe('105')
  })

  it('accepts decimal commas and rounds to two decimals', () => {
    const r = parsePohReply('{"fuelBurnLhr":"22,456","glideRatio":30}')
    expect(r.values.fuelBurnLhr).toBe('22.46')
  })

  it('makes descent rate positive', () => {
    expect(parsePohReply('{"descentFpm":-500}').values.descentFpm).toBe('500')
  })

  it('ignores unknown keys and non-numeric numbers', () => {
    const r = parsePohReply('{"cruiseIas":"fast","evil":"<script>","climbIas":75}')
    expect(r.values).toEqual({ climbIas: '75' })
    expect(r.missing).toContain('cruiseIas')
  })

  it('flags out-of-range values and inconsistent fields', () => {
    const r = parsePohReply('{"cruiseIas":100,"climbIas":110,"maxFuelL":40,"landingFuelL":45,"rocSlFpm":20000,"cruiseAltFt":12000,"serviceCeilingFt":10000}')
    expect(r.warnings.climbIas).toBeDefined()
    expect(r.warnings.landingFuelL).toBeDefined()
    expect(r.warnings.rocSlFpm).toBeDefined()
    expect(r.warnings.cruiseAltFt).toBeDefined()
    expect(r.warnings.cruiseIas).toBeUndefined()
  })

  it('reads climb rate at ceiling and descent burn, and cross-checks them', () => {
    const ok = parsePohReply('{"rocSlFpm":720,"rocCeilingFpm":100,"fuelBurnLhr":30,"descentFuelLhr":18}')
    expect(ok.values).toMatchObject({ rocCeilingFpm: '100', descentFuelLhr: '18' })
    expect(ok.warnings).toEqual({})
    const bad = parsePohReply('{"rocSlFpm":500,"rocCeilingFpm":600,"fuelBurnLhr":20,"descentFuelLhr":25}')
    expect(bad.warnings.rocCeilingFpm).toBeDefined()
    expect(bad.warnings.descentFuelLhr).toBeDefined()
  })

  it('reads fuel grades in the forms a POH or model writes them', () => {
    expect(parsePohReply('{"fuelTypes":["AVGAS100LL","MOGAS"]}').fuelTypes).toEqual(['AVGAS100LL', 'MOGAS'])
    expect(parseFuelGrades(['unleaded EN 228', 'UL 91', '100LL', 'Jet A-1', 'kerosene'])).toEqual(['MOGAS', 'AVGAS_UL91', 'AVGAS100LL', 'JETA1'])
    expect(parseFuelGrades('AVGAS 100LL / MOGAS')).toEqual(['AVGAS100LL', 'MOGAS'])
    expect(parsePohReply('{"cruiseIas":100}').fuelTypes).toEqual([])
  })

  it('reads runway distances and V-speeds and checks their order', () => {
    const ok = parsePohReply('{"takeoffDist50ftM":495,"landingDist50ftM":407,"vs0Kts":48,"vs1Kts":53,"vxKts":62,"climbIas":74,"vfeKts":85,"vaKts":105,"vnoKts":129,"vneKts":163}')
    expect(ok.values).toMatchObject({ takeoffDist50ftM: '495', vneKts: '163' })
    expect(ok.warnings).toEqual({})
    const bad = parsePohReply('{"vs0Kts":60,"vs1Kts":53,"vfeKts":140,"vnoKts":129,"vneKts":120}')
    expect(Object.keys(bad.warnings).sort()).toEqual(['vfeKts', 'vnoKts', 'vs0Kts'])
  })

  it('throws a pilot-readable error when there is no JSON', () => {
    expect(() => parsePohReply('Sorry, I cannot read PDFs.')).toThrow(PohReplyError)
    expect(() => parsePohReply('{"name": "C172", ')).toThrow(PohReplyError)
    expect(() => parsePohReply('[1,2]')).toThrow(PohReplyError)
    expect(() => parsePohReply('{"foo": 1}')).toThrow(PohReplyError)
    expect(() => parsePohReply('x'.repeat(60_000))).toThrow(PohReplyError)
  })
})
