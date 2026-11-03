import { describe, it, expect } from 'vitest'
import { nameFlownEvents, flightLogEventsForLog } from './flightLogEvents'
import type { FlownEvent } from './flightLogProfile'

const ev = (kind: FlownEvent['kind'], lat: number, lng: number, label: string): FlownEvent => ({
  kind, index: 0, label,
  point: { distNm: 0, lat, lng, altFt: 0, spdKts: 0, trkDeg: 0, elapsedMs: 0, ts: 0 },
})
const naming = {
  aerodromes: [{ icao: 'ESMI', lat: 55.5, lng: 13.5 }, { icao: 'ESMS', lat: 55.9, lng: 13.3 }],
  places: [{ name: 'Farm strip', lat: 56.5, lng: 14.5 }],
}

describe('nameFlownEvents', () => {
  it('names take-offs from and landings at the place they happened', () => {
    const out = nameFlownEvents([
      ev('takeoff', 55.5, 13.5, 'Takeoff'), ev('landing', 55.9, 13.3, 'Landing'), ev('touch-and-go', 55.5, 13.5, 'Touch-and-go'),
    ], naming)
    expect(out.map(e => e.label)).toEqual(['Takeoff from ESMI', 'Landing at ESMS', 'Touch-and-go at ESMI'])
  })

  it("uses the user's saved places too", () => {
    expect(nameFlownEvents([ev('landing', 56.5, 14.5, 'Landing')], naming)[0].label).toBe('Landing at Farm strip')
  })

  it('keeps the plain label away from every place, and leaves other events alone', () => {
    const out = nameFlownEvents([ev('landing', 50, 10, 'Landing'), ev('gap', 55.5, 13.5, 'GPS lost 1 min'), ev('airspace', 55.5, 13.5, 'Entered C X')], naming)
    expect(out.map(e => e.label)).toEqual(['Landing', 'GPS lost 1 min', 'Entered C X'])
  })

  it('without naming data the events are unchanged, and the input is not modified', () => {
    const input = [ev('takeoff', 55.5, 13.5, 'Takeoff')]
    expect(nameFlownEvents(input, null)[0].label).toBe('Takeoff')
    nameFlownEvents(input, naming)
    expect(input[0].label).toBe('Takeoff')
  })
})

describe('flightLogEventsForLog with naming', () => {
  // Take off at ESMI, climb, land at ESMS (one point per second).
  const t0 = Date.UTC(2026, 0, 1, 10)
  // 60 s standing on the ground at the end, so the landing is complete.
  const track = Array.from({ length: 200 }, (_, i) => {
    const spd = i < 20 ? i * 5 : i < 120 ? 95 : Math.max(0, 95 - (i - 120) * 6)
    // The roll-out and taxi keep moving a little, like a real recording.
    const lat = i < 20 ? 55.5 + i * 0.00002 : i < 120 ? 55.5 + (i - 20) * 0.004 : 55.9 + (i - 120) * 0.00002
    return { lat, lng: i < 20 ? 13.5 : i < 120 ? 13.5 - (i - 20) * 0.002 : 13.3, altFt: i < 20 || i >= 120 ? 50 : 1500, spdKts: spd, trkDeg: 0, ts: t0 + i * 1000 }
  })
  const log = { trackJson: JSON.stringify(track) }

  it('labels the take-off and landing with their places', async () => {
    const out = await flightLogEventsForLog(log, null, async () => null, async () => naming)
    const labels = out.map(e => e.label)
    expect(labels).toContain('Takeoff from ESMI')
    expect(labels).toContain('Landing at ESMS')
  })

  it('a failing or missing naming source gives the plain labels', async () => {
    for (const load of [undefined, async () => { throw new Error('offline') }, async () => null]) {
      const out = await flightLogEventsForLog(log, null, async () => null, load as never)
      expect(out.map(e => e.label)).toEqual(expect.arrayContaining(['Takeoff', 'Landing']))
    }
  })
})
