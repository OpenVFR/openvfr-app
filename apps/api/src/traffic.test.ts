import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLine, ognFilter } from './ognTraffic.js'
import { mergeTrafficStates, getFreshBatch, batchIsFresh, type TrafficState } from './traffic.js'

const NOW = 1_800_000_000

// Real lines from aprs.glidernet.org (an ADS-B target relayed by an OGN
// receiver, a FLARM tow plane and a receiver status beacon).
const ADSB = 'ICA4AB569>OGADSB,qAS,AVX1520:/185351h5901.31N/01811.86E^173/233/A=012066 !W86! id254AB569 +448fpm FL118.47 A2:SAS093'
const ADSB_NO_CALL = 'ICA4CA6D9>OGADSB,qAS,AVX1523:/185352h5547.78N/01211.16E^006/356/A=015848 !W72! id014CA6D9 +1984fpm FL154.91 Sq0242'
const FLARM = 'FLRDDA5BA>APRS,qAS,LFMX:/074556h4415.41N/00600.75E\'268/054/A=005524 id0ADDA5BA -019fpm +0.0rot 55.2dB 0e -4.9kHz'
const RECEIVER = 'NLF23A>OGNSDR,TCPIP*,qAC,GLIDERN1:/185354h6052.70NI01140.45E&/A=000660 AVIONIX ENGINEERING ADS-B/OGN receiver'

test('OGN-relayed ADS-B: ICAO address, flight callsign and category from the A<n>: field, course as track', () => {
  const s = parseLine(ADSB, NOW)!
  assert.equal(s.icao24, '4ab569')
  assert.equal(s.callsign, 'SAS093')
  assert.equal(s.category, 2)
  assert.equal(s.trackDeg, 173)
  assert.equal(s.posTime, NOW)
  assert.equal(s.source, 'ogn')
  // A= is GNSS, FL118.47 the pressure altitude.
  assert.ok(Math.abs(s.geoAltM! - 12066 * 0.3048) < 1e-9)
  assert.ok(Math.abs(s.altM! - 11847 * 0.3048) < 1e-6)
  // !W86! adds 0.008' / 0.006' to the minutes.
  assert.ok(Math.abs(s.lat! - (59 + 1.318 / 60)) < 1e-9)
  assert.ok(Math.abs(s.lon! - (18 + 11.866 / 60)) < 1e-9)
})

test('ICAO-addressed without a flight id has no callsign (so the OpenSky one can be used)', () => {
  assert.equal(parseLine(ADSB_NO_CALL, NOW)!.callsign, null)
})

test('FLARM tow plane (id0A): namespaced id, source call as label, light category', () => {
  const s = parseLine(FLARM, NOW)!
  assert.equal(s.icao24, 'ogn-dda5ba')
  assert.equal(s.callsign, 'FLRDDA5BA')
  assert.equal(s.category, 1)
  assert.equal(s.trackDeg, 268)
  assert.equal(s.altM, s.geoAltM)
  assert.ok(Math.abs(s.velocityMs! - 54 * 0.5144) < 1e-9)
})

test('course 000 means unknown track', () => {
  const s = parseLine(FLARM.replace("'268/054", "'000/000"), NOW)!
  assert.equal(s.trackDeg, null)
})

test('receiver beacons are not traffic', () => {
  assert.equal(parseLine(RECEIVER, NOW), null)
})

test('OGN filter defaults to the whole bbox, circle only when centre is set', () => {
  const bbox: [number, number, number, number] = [55, 10, 69.5, 24.5]
  assert.equal(ognFilter(bbox, {}), 'a/69.5/10/55/24.5')
  // docker-compose passes unset vars as '' and a default radius.
  assert.equal(ognFilter(bbox, { OGN_FILTER_LAT: '', OGN_FILTER_LON: '', OGN_FILTER_RADIUS_KM: '350' }), 'a/69.5/10/55/24.5')
  assert.equal(ognFilter(bbox, { OGN_FILTER_LAT: '57.7', OGN_FILTER_LON: '11.9', OGN_FILTER_RADIUS_KM: '200' }), 'r/57.7/11.9/200')
})

function state(p: Partial<TrafficState>): TrafficState {
  return {
    icao24: 'abc123', callsign: null, lat: 59, lon: 18, altM: 300, geoAltM: 330, velocityMs: 50, trackDeg: 90,
    vertRateMs: 0, onGround: false, lastContact: NOW, posTime: NOW, category: null, source: 'opensky', ...p,
  }
}

test('merge: the newer position wins, keeping what OpenSky knew', () => {
  const os = state({ posTime: NOW - 120, callsign: 'SECLB', category: 1 })
  const ogn = state({ posTime: NOW - 3, source: 'ogn', lat: 59.1 })
  const [m] = mergeTrafficStates([os], [ogn])
  assert.equal(m!.source, 'ogn')
  assert.equal(m!.lat, 59.1)
  assert.equal(m!.callsign, 'SECLB')
  assert.equal(m!.category, 1)
})

test('merge: an older OGN state does not replace OpenSky; OGN-only targets are added', () => {
  const os = state({ posTime: NOW })
  const ognOld = state({ posTime: NOW - 30, source: 'ogn' })
  const glider = state({ icao24: 'ogn-dda5ba', source: 'ogn' })
  const m = mergeTrafficStates([os], [ognOld, glider])
  assert.equal(m.length, 2)
  assert.equal(m.find(s => s.icao24 === 'abc123')!.source, 'opensky')
  assert.ok(m.some(s => s.icao24 === 'ogn-dda5ba'))
})

test('getFreshBatch: with nothing fresh it answers by its deadline, not fresh', async () => {
  assert.equal(batchIsFresh(null), false)
  const t0 = Date.now()
  const r = await getFreshBatch(50)
  assert.equal(r.fresh, false)
  assert.ok(Date.now() - t0 < 1000)
})
