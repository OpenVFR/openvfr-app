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
