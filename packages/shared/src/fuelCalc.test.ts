import { describe, it, expect } from 'vitest'
import { computeFuelPlan } from './fuelCalc'
import { iasToTas } from './airspeed'
import { distanceNm } from './routeCalc'
import type { AircraftProfileDocType } from './types'

const wp = (lat: number, lng: number) => ({ lat, lng, name: 'x' }) as never
const route = [wp(59, 18), wp(59, 19.9)]
const dist = distanceNm({ lat: 59, lng: 18 } as never, { lat: 59, lng: 19.9 } as never)
const base = {
  cruiseAltFt: 5000, cruiseIas: 100, fuelBurnLhr: 25, maxFuelL: 150, taxiFuelL: 5, landingFuelL: 20,
  holdingMin: 30, contingencyPct: 10, serviceCeilingFt: 14000, rocSlFpm: 700, rocCeilingFpm: 100,
  climbIas: 80, climbFuelLhr: 30, descentFpm: 500, descentIas: 100, descentFuelLhr: 15,
} as AircraftProfileDocType
const plan = (p: Partial<AircraftProfileDocType> = {}, ovr: never[] = []) => computeFuelPlan(route, ovr, { ...base, ...p })

describe('computeFuelPlan', () => {
  it('flies cruise at TAS, not IAS', () => {
    const f = plan({ rocSlFpm: 0, descentFpm: 0 })   // no climb/descent: all cruise
    expect(f.enrouteMins).toBeCloseTo((dist / iasToTas(100, 5000)) * 60, 4)
    expect(f.enrouteMins).toBeLessThan((dist / 100) * 60)
  })
  it('subtracts climb and descent DISTANCE from cruise', () => {
    const f = plan()
    expect(f.climbMins).toBeGreaterThan(0)
    expect(f.enrouteMins).toBeCloseTo(f.climbMins + f.descentMins + f.cruiseMins, 6)
  })
  it('climb/descent fuel burn falls back to cruise burn when unset, keeping the phase time', () => {
    const a = plan({ climbFuelLhr: 0, descentFuelLhr: 0 })
    expect(a.climbMins).toBeGreaterThan(0)
    expect(a.descentMins).toBeGreaterThan(0)
    expect(a.climbFuelL).toBeCloseTo((a.climbMins / 60) * 25, 6)
    expect(a.descentFuelL).toBeCloseTo((a.descentMins / 60) * 25, 6)
  })
  it('uses the profile burn when set', () => {
    const a = plan()
    expect(a.climbFuelL).toBeCloseTo((a.climbMins / 60) * 30, 6)
    expect(a.descentFuelL).toBeCloseTo((a.descentMins / 60) * 15, 6)
  })
  it('a route too short for climb+descent has no cruise', () => {
    const f = computeFuelPlan([wp(59, 18), wp(59, 18.1)], [{ altFt: 9000 }] as never, base)
    expect(f.cruiseMins).toBe(0)
  })
  it('diversion reserve uses the profile minutes, default 30', () => {
    expect(plan().diversionMin).toBe(30)
    expect(plan().diversionFuelL).toBeCloseTo(12.5, 6)
    const f = plan({ diversionMin: 45 })
    expect(f.diversionMin).toBe(45)
    expect(f.diversionFuelL).toBeCloseTo((45 / 60) * 25, 6)
  })

  describe('leg winds (override > global > forecast)', () => {
    const noClimb = { rocSlFpm: 0, descentFpm: 0 }
    const run = (ovr: object[], winds?: ({ dirDeg: number; speedKts: number } | null)[]) =>
      computeFuelPlan(route, ovr as never, { ...base, ...noClimb }, winds)
    it('a headwind from legWinds lengthens enroute time', () => {
      expect(run([], [{ dirDeg: 90, speedKts: 20 }]).enrouteMins).toBeGreaterThan(run([]).enrouteMins)   // track is due east: wind from 090 = headwind
    })
    it('a tailwind from legWinds shortens enroute time', () => {
      expect(run([], [{ dirDeg: 270, speedKts: 20 }]).enrouteMins).toBeLessThan(run([]).enrouteMins)
    })
    it('a manual leg wind beats legWinds', () => {
      const manual = run([{ windDir: 270, windSpd: 20 }], [{ dirDeg: 90, speedKts: 20 }])
      expect(manual.enrouteMins).toBeCloseTo(run([{ windDir: 270, windSpd: 20 }]).enrouteMins, 6)
    })
    it('null legWinds entry means still air', () => {
      expect(run([], [null]).enrouteMins).toBeCloseTo(run([]).enrouteMins, 6)
    })
  })
})
