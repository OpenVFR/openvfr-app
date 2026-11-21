import { describe, it, expect } from 'vitest'
import { formatPreflightWarning, type PreflightWarningItem } from './preflightWarnings'

const f = (i: PreflightWarningItem) => { const w = formatPreflightWarning(i); return [w.title, w.detail] }

describe('formatPreflightWarning: the English of every warning code', () => {
  it('terrain, route data, aerodromes, notams, aircraft, assistant', () => {
    expect(f({ level: 'warn', code: 'terrain-unavailable', params: { hasMsa: false } })).toEqual(['Terrain data unavailable',
      'No elevation data for this route: the Minimum Safe Altitude check was skipped and airspace limits given above ground (AGL) are checked at their raw height.'])
    expect(f({ level: 'warn', code: 'terrain-unavailable', params: { hasMsa: true } })[1]).toMatch(/^No elevation data for this route: the Minimum Safe Altitude check uses the terrain maximum grid/)
    expect(f({ level: 'warn', code: 'route-data-unavailable', params: { airspace: true, obstacles: true } })).toEqual(['Route data unavailable: airspace and obstacles and landmarks',
      'The airspace and obstacles and landmarks file could not be loaded, so airspace and obstacle clearance was not checked. Check the connection or download the area for offline use.'])
    expect(f({ level: 'warn', code: 'route-data-unavailable', params: { airspace: false, obstacles: true } })).toEqual(['Route data unavailable: obstacles and landmarks',
      'The obstacles and landmarks file could not be loaded, so obstacle clearance was not checked. Check the connection or download the area for offline use.'])
    expect(f({ level: 'info', code: 'aerodromes-unavailable', params: {} })).toEqual(['Aerodrome data unavailable', 'Airfield proximity was not checked.'])
    expect(f({ level: 'info', code: 'notams-unavailable', params: { reason: 'Sign in to check' } })).toEqual(['NOTAM restricted areas not checked', 'Sign in to check'])
    expect(f({ level: 'warn', code: 'aircraft-profile-missing', params: {} })[0]).toBe('Aircraft not found')
    expect(f({ level: 'warn', code: 'aircraft-assistant-review', params: { review: { by: 'Bot', change: 'created', at: 0 } as never } })).toEqual(['Check the aircraft profile',
      'Added by Bot (assistant connection). Fuel, speeds and runway checks use these values: compare them with the POH, then open and save the aircraft.'])
    expect(f({ level: 'warn', code: 'route-assistant-review', params: { review: { by: 'Bot', change: ['route'], at: 0 } as never } })).toEqual(['Check the route',
      'Changed by Bot: route (assistant connection). Check every point, level and fuel stop on the map, then save the route.'])
  })

  it('water beyond gliding distance, with and without wind', () => {
    const base = { sea: true, name: null, maxFromLandNm: 12, atNm: 30.4, beyondGlideNm: 5, altFt: 3500, glideRangeNm: 6, glideRatio: 9, glideAssumed: true,
      windFromDeg: null, windKts: null, driftNm: null, neededFt: null, climbToFt: null }
    expect(f({ level: 'warn', code: 'water-beyond-glide', params: base })).toEqual(['Beyond gliding distance from land over the sea',
      'Up to 12 NM from land (at NM 30); about 5 NM of the route is beyond gliding distance. From 3,500 ft you glide about 6 NM in still air (glide ratio 9:1, assumed: set it in the aircraft profile). '
      + 'Reaching land from there needs more than a 60 NM glide. Route closer to the shore, or carry life jackets for everyone on board (required for single-engine aircraft beyond gliding distance from land) and plan for ditching.'])
    const w = f({ level: 'warn', code: 'water-beyond-glide', params: { ...base, sea: false, name: 'Vättern', glideAssumed: false, windFromDeg: 90, windKts: 15, driftNm: 2, neededFt: 4200, climbToFt: 4200 } })
    expect(w[0]).toBe('Beyond gliding distance from land over Vättern')
    expect(w[1]).toBe('Up to 12 NM from land (at NM 30); about 5 NM of the route is beyond gliding distance. From 3,500 ft you glide about 6 NM in still air (glide ratio 9:1); '
      + 'the planned wind (090° at 15 kt) is included and moves the area you can reach about 2 NM downwind. Reaching land from there needs about 4,200 ft with that wind. '
      + 'Climb to about 4,200 ft, route closer to the shore, or carry life jackets for everyone on board (required for single-engine aircraft beyond gliding distance from land) and plan for ditching.')
  })

  it('airspace', () => {
    const p = { bandClass: 'C', bandType: 'CTR', name: 'Linköping', plannedFt: 2500, lowerFt: 0, upperFt: 3500 }
    expect(f({ level: 'warn', code: 'airspace-penetration', params: p })).toEqual(['Class C CTR penetration — Linköping', 'Planned altitude 2,500 ft enters 0–3,500 ft'])
    expect(f({ level: 'danger', code: 'airspace-equipment', params: { ...p, lacks: 'radio' } })).toEqual(['Class C CTR Linköping needs a radio',
      'Planned altitude 2,500 ft enters 0–3,500 ft. The aircraft profile has no radio: route around it, or above or below it.'])
    expect(f({ level: 'danger', code: 'airspace-equipment', params: { ...p, bandClass: 'TMZ', bandType: 'TMZ', lacks: 'transponder' } })[0]).toBe('TMZ Linköping needs a transponder')
    expect(f({ level: 'warn', code: 'airspace-penetration', params: { ...p, bandClass: 'R', bandType: 'R' } })[0]).toBe('Restricted / danger area penetration — Linköping')
    expect(f({ level: 'warn', code: 'airspace-penetration', params: { ...p, bandClass: 'D', bandType: 'CTR' } })[0]).toBe('Class D CTR penetration — Linköping')
    expect(f({ level: 'warn', code: 'airspace-penetration', params: { ...p, bandClass: 'RMZ', bandType: '' } })[0]).toBe('RMZ penetration — Linköping')
  })

  it('terrain, proximity, fuel, crosswind, runway', () => {
    expect(f({ level: 'danger', code: 'below-msa', params: { fromName: 'ESSL', toName: 'ESSB', plannedFt: 1499.6, requiredFt: 2300, terrainClearanceFt: 1000, abeamNm: 5, obstacleClearanceFt: 500 } }))
      .toEqual(['Leg ESSL → ESSB below Minimum Safe Altitude', 'Planned 1,500 ft, minimum safe 2,300 ft (terrain + 1,000 ft within 5 NM, obstacles + 500 ft). Check Virtual Radar.'])
    expect(f({ level: 'warn', code: 'airfield-proximity', params: { label: 'ESCF', lateralNm: 0.84, distNm: 40.4, plannedFt: 1800, elevationFt: 321.2 } }))
      .toEqual(['Passes close to ESCF', '0.8 NM from the track at 40 NM, planned 1,800 ft over a field at 321 ft: expect circuit and arriving or departing traffic.'])
    expect(f({ level: 'danger', code: 'fuel-insufficient', params: { hop: null, requiredL: 61.234, availableL: 50 } })).toEqual(['Insufficient fuel', 'Requires 61.2 L — available 50.0 L'])
    expect(f({ level: 'warn', code: 'fuel-tight', params: { hop: { from: 'ESSL', to: 'WP3' }, requiredL: 45, availableL: 50 } })).toEqual(['Tight fuel margin (ESSL → WP3)', 'Requires 45.0 L of 50.0 L available'])
    expect(f({ level: 'warn', code: 'crosswind', params: { icao: 'ESSB', role: 'destination', windText: '270/20', crosswindKt: 18, runway: '12', limitKt: 15 } }))
      .toEqual(['Crosswind at ESSB (destination)', "Current wind 270/20: 18 kt across runway 12, the best runway, above the aircraft's 15 kt maximum demonstrated crosswind. Check the forecast for your arrival time."])
    const rw = { designator: '06', lengthM: 600, surface: 'GRASS', paved: false }
    expect(f({ level: 'danger', code: 'runway-short', params: { op: 'takeoff', icao: 'ESMS', role: 'departure', requiredM: 1234, tempC: 25, safety: 1.33, runway: rw } }))
      .toEqual(['Runway short for take-off at ESMS (departure)', "Needs about 1,234 m: the aircraft's take-off distance over 50 ft, scaled for elevation, 25 °C, surface and a 1.33 safety factor. Best is runway 06 (600 m grass). Check the POH for today's mass and conditions."])
    expect(f({ level: 'danger', code: 'runway-short', params: { op: 'landing', icao: 'ESMS', role: 'destination', requiredM: 900, tempC: null, safety: 1.43, runway: { designator: null, lengthM: 800, surface: '', paved: false } } })[1])
      .toBe("Needs about 900 m: the aircraft's landing distance from 50 ft, scaled for elevation, surface and a 1.43 safety factor. Best is the longest runway (800 m unknown surface). Check the POH for today's mass and conditions.")
  })

  it('keeps level, fix, focus and leg, and the params', () => {
    const w = formatPreflightWarning({ level: 'danger', code: 'below-msa', params: { fromName: 'A', toName: 'B', plannedFt: 1000, requiredFt: 2000, terrainClearanceFt: 1000, abeamNm: 5, obstacleClearanceFt: 500 },
      fix: { kind: 'raise-leg', legIndex: 1, altFt: 2000 }, focusNm: 4, legIndex: 1 })
    expect(w).toMatchObject({ level: 'danger', code: 'below-msa', fix: { legIndex: 1 }, focusNm: 4, legIndex: 1, params: { requiredFt: 2000 } })
  })
})
