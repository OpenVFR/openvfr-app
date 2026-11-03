import { describe, it, expect } from 'vitest'
import { trackToGpx, gpxToTrack, type GpxTrackPoint } from './gpx'

const pts = (t0: number, n: number): GpxTrackPoint[] =>
  Array.from({ length: n }, (_, i) => ({ lat: 59 + i * 0.001, lng: 18, altFt: 1000 + i * 10, spdKts: 90, trkDeg: 270, ts: t0 + i * 1000 }))

describe('trackToGpx / gpxToTrack', () => {
  it('round-trips points', () => {
    const src = pts(Date.UTC(2026, 0, 1, 10), 5)
    const out = gpxToTrack(trackToGpx(src, 'ESSA → ESSB & back'))
    expect(out.name).toBe('ESSA → ESSB & back')
    expect(out.points).toHaveLength(5)
    expect(out.points[2].lat).toBeCloseTo(src[2].lat, 6)
    expect(out.points[2].ts).toBe(src[2].ts)
    expect(out.points[2].altFt).toBeCloseTo(src[2].altFt, 0)
    expect(out.points[2].spdKts).toBe(90)
    expect(out.points[2].trkDeg).toBe(270)
  })

  it('splits a GPS gap into a new trkseg', () => {
    const xml = trackToGpx([...pts(0, 3), ...pts(200_000, 3)])
    expect(xml.match(/<trkseg>/g)).toHaveLength(2)
    expect(gpxToTrack(xml).points).toHaveLength(6)
  })

  it('exports altitude in metres', () => {
    const xml = trackToGpx([{ lat: 1, lng: 2, altFt: 1000, spdKts: 0, trkDeg: 0, ts: 0 }])
    expect(xml).toContain('<ele>304.8</ele>')
  })

  it('rejects files without a track', () => {
    expect(() => gpxToTrack('<gpx></gpx>')).toThrow()
  })
})

import { flightLogToGpx } from './gpx'
describe('flightLogToGpx', () => {
  const base = { startedAt: Date.UTC(2026, 0, 1), departureIcao: 'ESSA', arrivalIcao: 'ESSB', registration: 'SE-ABC' }
  it('names the file from route, registration and date', () => {
    const r = flightLogToGpx({ ...base, trackJson: JSON.stringify(pts(0, 2)) })
    expect(r.filename).toBe('ESSA-ESSB_SE-ABC_2026-01-01.gpx')
    expect(r.xml).toContain('ESSA → ESSB')
  })
  it('falls back for a log without route info', () => {
    const r = flightLogToGpx({ ...base, departureIcao: '', arrivalIcao: '', registration: '', trackJson: JSON.stringify(pts(0, 2)) })
    expect(r.filename).toBe('2026-01-01.gpx')
  })
  it('throws on an empty track', () => {
    expect(() => flightLogToGpx({ ...base, trackJson: '[]' })).toThrow()
  })
})

import { gpxToFlightLog, gpxToRoute, trackDistanceNm } from './gpx'
import { flightLogEvents } from './flightLogEvents'
describe('gpxToFlightLog', () => {
  // A foreign GPX: no extensions, no speed. 1 point/s heading north at ~60 kt
  // (0.01667 NM/s = 0.000278 deg lat/s).
  const foreign = (n: number) => `<?xml version="1.0"?><gpx version="1.1"><trk><name>x</name><trkseg>${
    Array.from({ length: n }, (_, i) =>
      `<trkpt lat="${59 + i * (1 / 3600)}" lon="18"><ele>300</ele><time>${new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString()}</time></trkpt>`).join('')
  }</trkseg></trk></gpx>`

  it('derives speed and track when the file has none', () => {
    const { points } = gpxToTrack(foreign(10))
    expect(points[3].spdKts).toBeGreaterThan(55)
    expect(points[3].spdKts).toBeLessThan(65)
    expect(points[3].trkDeg).toBe(0)
    expect(points[9].spdKts).toBeGreaterThan(55) // last point reuses previous leg
  })

  it('builds a log doc from start/end, distance and max altitude', () => {
    const d = gpxToFlightLog(foreign(61), 'id-1', 123)
    expect(d.id).toBe('id-1')
    expect(d.endedAt - d.startedAt).toBe(60_000)
    expect(d.distanceNm).toBeCloseTo(1, 1)
    // Whole feet: the server column is an integer and refuses 984.25.
    expect(d.maxAltFt).toBe(Math.round(300 / 0.3048))
    expect(d.updatedAt).toBe(123)
    expect(JSON.parse(d.trackJson)).toHaveLength(61)
  })

  it('sorts out-of-order points and rejects too-short tracks', () => {
    expect(() => gpxToFlightLog(foreign(1), 'x')).toThrow()
  })

  it('round trip of own export keeps its speeds', () => {
    const src = pts(0, 5)
    expect(gpxToTrack(trackToGpx(src)).points[1].spdKts).toBe(90)
  })

  it('trackDistanceNm', () => {
    expect(trackDistanceNm([{ lat: 59, lng: 18 }, { lat: 60, lng: 18 }])).toBeCloseTo(60, 3)
  })
})

describe('a flight log through GPX and back', () => {
  const route = {
    name: 'ESSA-ESSB',
    waypoints: [{ lat: 59.65, lng: 17.92, name: 'ESSA' }, { lat: 59.5, lng: 17.5 }, { lat: 59.35, lng: 18.07, name: 'ESSB & co <1>' }],
    legOverrides: [{ altFt: 3000, speedKts: 95 }, { windDir: 270, windSpd: 12 }],
  }
  const log = {
    startedAt: Date.UTC(2026, 0, 1, 10), departureIcao: 'ESSA', arrivalIcao: 'ESSB', registration: 'SE-ABC',
    trackJson: JSON.stringify(pts(Date.UTC(2026, 0, 1, 10), 20)), routeJson: JSON.stringify(route),
  }

  it('keeps airports, registration and the planned route', () => {
    const doc = gpxToFlightLog(flightLogToGpx(log).xml, 'new-id')
    expect(doc.departureIcao).toBe('ESSA')
    expect(doc.arrivalIcao).toBe('ESSB')
    expect(doc.registration).toBe('SE-ABC')
    expect(JSON.parse(doc.routeJson!)).toEqual(route)
  })

  it('writes the route as a plain <rte> that other tools can read', () => {
    const { xml } = flightLogToGpx(log)
    const r = gpxToRoute(xml)
    expect(r.name).toBe('ESSA-ESSB')
    expect(r.waypoints).toHaveLength(3)
    expect(r.waypoints[2].name).toBe('ESSB & co <1>')
  })

  it('declares the namespace once and keeps the track points', () => {
    const { xml } = flightLogToGpx(log)
    expect(xml.match(/xmlns:ovfr=/g)).toHaveLength(1)
    const doc = gpxToFlightLog(xml, 'x')
    expect(JSON.parse(doc.trackJson)).toHaveLength(20)
    expect(doc.startedAt).toBe(log.startedAt)
  })

  it('a log without a route or airports exports and imports without them', () => {
    const doc = gpxToFlightLog(flightLogToGpx({ ...log, departureIcao: '', arrivalIcao: '', registration: '', routeJson: undefined }).xml, 'x')
    expect(doc.routeJson).toBeUndefined()
    expect([doc.departureIcao, doc.arrivalIcao, doc.registration]).toEqual(['', '', ''])
  })

  it('an unreadable stored route does not stop the export', () => {
    const { xml } = flightLogToGpx({ ...log, routeJson: '{not json' })
    expect(gpxToFlightLog(xml, 'x').routeJson).toBeUndefined()
  })

  it('a foreign file with a <rte> imports it as the planned route', () => {
    const foreign = `<gpx version="1.1"><rte><name>R</name><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte><trk><trkseg>${
      [0, 1].map((i) => `<trkpt lat="${59 + i}" lon="18"><time>${new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString()}</time></trkpt>`).join('')
    }</trkseg></trk></gpx>`
    expect(JSON.parse(gpxToFlightLog(foreign, 'x').routeJson!).waypoints).toHaveLength(2)
  })
})

describe('events after a GPX round trip', () => {
  // Take off, fly, land: speeds ramp across the 40/30 kt thresholds so rounding could move the events.
  const t0 = Date.UTC(2026, 0, 1, 10)
  const track: GpxTrackPoint[] = Array.from({ length: 120 }, (_, i) => {
    const spd = i < 20 ? i * 4.13 : i < 100 ? 95.37 : Math.max(0, 95.37 - (i - 100) * 5.77)
    return { lat: 59 + i * 0.0007, lng: 18, altFt: i < 20 ? 100 : i < 100 ? 100 + (i - 20) * 12.3 : 100, spdKts: spd, trkDeg: 0, ts: t0 + i * 1000 }
  })
  const thr = { takeoffKts: 40, landedKts: 30 }

  it('finds the same events from the exported track as from the original', () => {
    const before = flightLogEvents(track, null, thr)
    const doc = gpxToFlightLog(flightLogToGpx({ startedAt: t0, departureIcao: '', arrivalIcao: '', registration: '', trackJson: JSON.stringify(track) }).xml, 'x')
    const after = flightLogEvents(JSON.parse(doc.trackJson), null, thr)
    expect(before.length).toBeGreaterThan(0)
    expect(after.map((e) => [e.kind, e.ts])).toEqual(before.map((e) => [e.kind, e.ts]))
  })
})
