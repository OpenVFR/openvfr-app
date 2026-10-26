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

import { gpxToFlightLog, trackDistanceNm } from './gpx'
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
