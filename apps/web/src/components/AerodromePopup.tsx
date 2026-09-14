import { useState, useEffect } from 'react'
import css from './AerodromePopup.module.css'
import { fetchWxResolved, decodeMetar, parseMetarWind, parseMetarClouds, type WxResolved, type WxStationCandidate, type ParsedWind } from '../utils/fetchWx'
import { parseTaf, type TafPeriod } from '@open-vfr/shared/parseTaf'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { computeRunwayWind, effectiveMagBrg, type RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import { WindCompassGauge, WindSpeedGauge, type RunwayHeading } from './WindGauges'
import { visTone, ceilingTone, windTone, fmtVis, fmtWind, fmtObsAge, metarNarrative } from '../utils/wxFormat'
import TafTimeline from './TafTimeline'
import CloudProfile from './CloudProfile'
import { fetchNotams, fmtNotamDate, type NotamItem } from '../utils/fetchNotam'
import { sunriseSunset, fmtSunTime } from '../utils/sunCalc'
import { computeAtcStatus, anyNotamAtcRelated, anyNotamHoursChangeRelated } from '@open-vfr/shared/atcStatus'
import { API_BASE_URL, TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'

// ── Types matching the GeoJSON properties schema ─────────────────────────────

interface Frequency {
  service: string
  freq_mhz: number
  callsign: string
}

interface Threshold {
  designator: string
  lat: number
  lon: number
  true_brg: number | null
  mag_brg: number | null
}

interface Runway {
  designator: string
  length_m: number | null
  width_m: number | null
  surface: string
  thresholds: Threshold[]
}

interface Runway {
  designator: string
  length_m: number | null
  width_m: number | null
  surface: string
  thresholds: Threshold[]
  lighting?: string[]
  visual_approach_aids?: string[]
  declared_distances?: { tora?: number; toda?: number; asda?: number; lda?: number } | null
}

interface Contact {
  type: string
  address: string
}

interface HoursEntry {
  day: string | null
  start: string | null
  end: string | null
  sunrise: boolean
  sunset: boolean
  by_notam: boolean
  remarks: string
}

export interface AerodromeFeatureProps {
  icao: string
  name: string
  type: string               // 'AD' | 'HP' | 'AH'
  elevation_ft: number | null
  frequencies: Frequency[]
  fuel: string[]             // e.g. ['AVGAS', 'A1']
  ppr: boolean
  ppr_remarks: string[]
  contacts: Contact[]
  runways: Runway[]
  /** Derived at data-prep time: true if any frequency has service === 'TWR'. */
  towered?: boolean
  hours_of_operation?: HoursEntry[]
  handling_facilities?: string[]
  passenger_facilities?: string[]
}

interface Props {
  props: AerodromeFeatureProps
  /** WGS84 coordinates of the aerodrome (from feature geometry) */
  lng: number
  lat: number
  isHome: boolean
  /** Signed-in state — weather/NOTAM fetches require auth server-side, so skip
   * them entirely (rather than firing a guaranteed 401) when logged out. */
  authed: boolean
  onSetHome: (icao: string, name: string, lng: number, lat: number) => void
  onClose: () => void
  /**
   * Reports the current wind-derived per-end favored/severity state so the
   * map's 'runway-threshold-label' layer can highlight the same favored
   * runway end shown here (see MapView's runwayWindHighlight state) — not
   * just inside this popup. Called with an empty array to clear whenever
   * there's no usable wind (no METAR yet, CALM, VRB) so the map never shows
   * a stale highlight from a previous METAR fetch.
   */
  onRunwayWind?: (icao: string, ends: RunwayWindEnd[]) => void
}

// ── Nearby-station cache (for METAR/TAF fallback) ─────────────────────────────
// Minimal {icao,name,lat,lng} index of every aerodrome, loaded once and
// shared across all AerodromePopup instances -- same module-level-cache
// pattern as useAirfieldBrief.ts's loadAerodromes(), kept separate here
// since this only needs three fields (not the full AerodromeFeatureProps).

interface StationRecord { icao: string; name: string; lat: number; lng: number }

let cachedStations: StationRecord[] | null = null
let stationsLoadPromise: Promise<StationRecord[]> | null = null

function loadStations(): Promise<StationRecord[]> {
  if (cachedStations) return Promise.resolve(cachedStations)
  if (stationsLoadPromise) return stationsLoadPromise
  stationsLoadPromise = fetch(versionedTileUrl(TILES_BASE_URL, 'se-aerodromes.geojson'))
    .then((r) => r.json())
    .then((fc: GeoJSON.FeatureCollection) => {
      const arr: StationRecord[] = []
      for (const f of fc.features) {
        if (f.geometry.type !== 'Point') continue
        const p = f.properties as Record<string, unknown>
        const icao = String(p['icao'] ?? '')
        if (!icao) continue
        const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
        arr.push({ icao, name: String(p['name'] ?? ''), lat, lng })
      }
      cachedStations = arr
      return arr
    })
    .catch(() => { stationsLoadPromise = null; return [] })
  return stationsLoadPromise
}

// Fallback search radius -- wide enough to reach a towered/AWOS-equipped
// aerodrome from a small grass strip, capped so a request burst never goes
// further than genuinely useful for pre-flight/enroute weather.
const WX_FALLBACK_MAX_NM = 100

// ── Helpers ───────────────────────────────────────────────────────────────────

const SERVICE_LABEL: Record<string, string> = {
  TWR: 'TWR',
  APP: 'APP',
  ATIS: 'ATIS',
  ATIS_ARR: 'ATIS ARR',
  ATIS_DEP: 'ATIS DEP',
  SMC: 'GROUND',
  AFIS: 'AFIS',
  FIS: 'FIS',
  ACS: 'ACC',
  RDO: 'RADIO',
  INFO: 'INFO',
  MET: 'MET',
  COM: 'COM',
  SFC: 'SFC',
  OTHER: 'OTHER',
}

const SURFACE_LABEL: Record<string, string> = {
  ASPH: 'Asphalt',
  CONC: 'Concrete',
  GRASS: 'Grass',
  SAND: 'Sand',
}

const FUEL_LABEL: Record<string, string> = {
  AVGAS: 'AVGAS',
  A1: 'JET-A1',
  'OCT91-98': '100LL',
  MOGAS: 'MOGAS',
}

const CONTACT_LABEL: Record<string, string> = {
  PHONE: 'Phone',
  'PHONE-MET': 'Met',
  EMAIL: 'Email',
  URL: 'Web',
  RADIO: 'Radio',
  AFS: 'AFS',
}

const LIGHTING_LABEL: Record<string, string> = {
  REIL: 'REIL', REL: 'Runway End Lights', EDGE: 'Edge Lights', CENTERLINE: 'Centerline',
  TDZ: 'TDZ Lights', TAXI_LEAD_OFF: 'Taxi Lead-off', TAXI_LEAD_ON: 'Taxi Lead-on',
  LAHSO: 'LAHSO', ALS: 'Approach Lighting', THRESHOLD: 'Threshold Lights', OTHER: 'Lighting',
}

const VASI_LABEL: Record<string, string> = {
  VASI: 'VASI', PAPI: 'PAPI', TRI_COLOR_VASI: 'Tri-Color VASI',
  PULSATING_VASI: 'Pulsating VASI', AOES: 'AOES', OTHER: 'Visual Aid',
}

const HANDLING_LABEL: Record<string, string> = {
  CARGO: 'Cargo Handling', DE_ICING: 'De-Icing', MAINTENANCE: 'Maintenance',
  SECURITY: 'Security', SHELTER: 'Shelter', OTHER: 'Handling',
}

const PASSENGER_LABEL: Record<string, string> = {
  BANK: 'Bank', POST: 'Post Office', CUSTOMS: 'Customs', LODGING: 'Lodging',
  MEDICAL: 'Medical', RESTAURANT: 'Restaurant', SANITATION: 'Sanitation',
  TRANSPORTATION: 'Transportation', LAUNDRY: 'Laundry', CAMPING: 'Camping', OTHER: 'Facility',
}

const DAY_LABEL: Record<string, string> = {
  MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun',
}

function fuelBadge(code: string): string {
  return FUEL_LABEL[code] ?? code
}

// Per-metric colour tone (visTone/ceilingTone/windTone) and text formatting
// (fmtVis/fmtWind) now live in ../utils/wxFormat.ts -- shared with
// TafTimeline's hourly table so both use identical thresholds/formatting.

const TAF_PERIOD_LABEL: Record<string, string> = {
  BASE: 'FCST', FM: 'FROM', BECMG: 'BECMG', TEMPO: 'TEMPO', PROB30: 'PROB30', PROB40: 'PROB40',
}

function fmtTafTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`
}

function fmtTafClouds(clouds: { cover: string; baseFt: number }[]): string {
  if (clouds.length === 0) return 'CAVOK/NSC'
  return clouds.map((c) => `${c.cover}${String(Math.round(c.baseFt / 100)).padStart(3, '0')}`).join(' ')
}

function surfaceLabel(code: string): string {
  return SURFACE_LABEL[code] ?? code
}

function serviceLabel(code: string): string {
  return SERVICE_LABEL[code] ?? code
}

function fmtHoursEntry(h: HoursEntry): string {
  const day = h.day ? DAY_LABEL[h.day] ?? h.day : 'Daily'
  let time: string
  if (h.by_notam) time = 'By NOTAM'
  else if (h.sunrise && h.sunset) time = 'SR–SS'
  else if (h.sunrise && h.end) time = `SR–${h.end}`
  else if (h.start && h.sunset) time = `${h.start}–SS`
  else if (h.start && h.end) time = `${h.start}–${h.end}`
  else time = '—'
  return `${day}  ${time}`
}

function fmtDeclaredDistances(dd: Runway['declared_distances']): string {
  if (!dd) return ''
  const parts: string[] = []
  if (dd.tora != null) parts.push(`TORA ${dd.tora}`)
  if (dd.toda != null) parts.push(`TODA ${dd.toda}`)
  if (dd.asda != null) parts.push(`ASDA ${dd.asda}`)
  if (dd.lda  != null) parts.push(`LDA ${dd.lda}`)
  return parts.join(' · ')
}

// Deduplicate contacts: same type+address may appear twice
function uniqueContacts(contacts: Contact[]): Contact[] {
  const seen = new Set<string>()
  return contacts.filter((c) => {
    const key = `${c.type}|${c.address}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AerodromePopup({ props: p, lng, lat, isHome, authed, onSetHome, onClose, onRunwayWind }: Props) {
  const fuelList = p.fuel ?? []
  const hasFuel = fuelList.length > 0
  const contacts = uniqueContacts(p.contacts ?? [])
  const freqs = p.frequencies ?? []
  const runways = p.runways ?? []
  const remarks = p.ppr_remarks ?? []
  const hours = p.hours_of_operation ?? []
  const handling = p.handling_facilities ?? []
  const passenger = p.passenger_facilities ?? []

  // ── Tab state ─────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'info' | 'wx' | 'notam'>('info')

  // ── Wx-tab compass runway selector ────────────────────────────
  // null = auto (longest runway, previous default behaviour). Airports with
  // more than one runway (e.g. ESMS: 17/35 + 11/29) need an explicit way to
  // look at a different one than whichever is longest.
  const [selectedRunwayDesig, setSelectedRunwayDesig] = useState<string | null>(null)
  useEffect(() => { setSelectedRunwayDesig(null) }, [p.icao])

  // ── Sunrise / Sunset ─────────────────────────────────────────────────────
  const sunTimes = sunriseSunset(lat, lng)

  // ── Density altitude inputs ───────────────────────────────────────────────
  const [oatStr, setOatStr] = useState('')
  const [qnhStr, setQnhStr] = useState('')

  // ── Weather (METAR / TAF) ─────────────────────────────────────────────────
  const [wx, setWx] = useState<WxResolved | null>(null)
  const [wxLoading, setWxLoading] = useState(true)
  const [wxError, setWxError] = useState<string | null>(null)
  const [tafExpanded, setTafExpanded] = useState(false)
  // Name of the fallback station (wx.sourceIcao), resolved from the same
  // station index used to find fallback candidates -- kept separate from
  // `wx` so the banner can show a human name, not just the ICAO.
  const [wxSourceName, setWxSourceName] = useState<string | null>(null)

  // ── NOTAMs ────────────────────────────────────────────────────────────────
  const [notams, setNotams] = useState<NotamItem[]>([])
  const [notamLoading, setNotamLoading] = useState(true)
  const [notamError, setNotamError] = useState<string | null>(null)
  const [expandedNotams, setExpandedNotams] = useState<Set<string>>(new Set())

  // ── ATC status (towered airports only) ───────────────────────────────────
  // AIP-schedule-derived only (see @open-vfr/shared/atcStatus) — NOTAM text
  // is checked separately below and only ever surfaces as a plain-text hint,
  // never flips this badge's color/status.
  const atc = p.towered ? computeAtcStatus(hours, sunTimes) : null
  const activeNotamTexts = notams
    .filter((n) => {
      const now = Date.now()
      const eff = n.effective ? Date.parse(n.effective) : null
      const exp = n.expires ? Date.parse(n.expires) : null
      if (eff != null && now < eff) return false
      if (exp != null && now > exp) return false
      return true
    })
    .map((n) => n.text)
  const notamAtcHint = p.towered && anyNotamAtcRelated(activeNotamTexts)
  const notamHoursHint = p.towered && anyNotamHoursChangeRelated(activeNotamTexts)

  useEffect(() => {
    const ac = new AbortController()
    setWx(null); setWxLoading(true); setWxError(null); setWxSourceName(null)
    setNotams([]); setNotamLoading(true); setNotamError(null)
    setTafExpanded(false); setExpandedNotams(new Set())

    if (!authed) {
      // Not signed in — server requires auth for these, skip the guaranteed 401.
      setWxLoading(false); setNotamLoading(false)
      return () => ac.abort()
    }

    // Nearby-candidate list for the METAR/TAF fallback -- resolved from the
    // shared station index (loaded once, cached) sorted by distance from
    // this aerodrome. Only actually hits the network beyond p.icao itself
    // when p.icao has neither a METAR nor a TAF (see fetchWxNearest).
    loadStations().then((stations) => {
      if (ac.signal.aborted) return
      const candidates: WxStationCandidate[] = stations
        .filter((s) => s.icao !== p.icao)
        .map((s) => ({ icao: s.icao, distNm: distanceNm({ lat, lng }, { lat: s.lat, lng: s.lng }) }))
        .filter((c) => c.distNm <= WX_FALLBACK_MAX_NM)
        .sort((a, b) => a.distNm - b.distNm)
      const nameByIcao = new Map(stations.map((s) => [s.icao, s.name]))

      fetchWxResolved(p.icao, lat, lng, candidates, API_BASE_URL, ac.signal)
        .then((data) => {
          setWx(data)
          setWxSourceName(data.sourceIcao !== p.icao ? (nameByIcao.get(data.sourceIcao) ?? null) : null)
          setWxLoading(false)
        })
        .catch((err) => {
          if ((err as Error).name !== 'AbortError') {
            setWxError('Weather unavailable')
            setWxLoading(false)
          }
        })
    })

    fetchNotams(p.icao, API_BASE_URL, ac.signal)
      .then((data) => { setNotams(data.notams); setNotamLoading(false) })
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') {
          setNotamError('NOTAM service unavailable')
          setNotamLoading(false)
        }
      })

    return () => ac.abort()
  }, [p.icao, authed, lat, lng])

  const metar = wx?.metar ? decodeMetar(wx.metar) : null
  const surfaceWind = metar ? parseMetarWind(metar.wind) : null
  // Open-Meteo model wind (fetchWxResolved's modelWind), reshaped into the
  // same ParsedWind the compass/speed gauge/windTone/fmtWind already know
  // how to render -- only ever populated when there's no real METAR/TAF
  // anywhere (see fetchWxResolved's own doc comment).
  const modelWind: ParsedWind | null = wx?.modelWind
    ? { dirDeg: wx.modelWind.dirDeg, speedKt: wx.modelWind.speedKts, gustKt: null, variable: false, calm: wx.modelWind.speedKts === 0 }
    : null
  const tafPeriods: TafPeriod[] | null = wx?.taf ? parseTaf(wx.taf) : null
  const usingFallbackWx = !!wx && wx.sourceIcao !== p.icao

  // Flattened across all runways at this aerodrome, computed once here (not
  // inside the JSX .map() below) so it can also be reported to the map via
  // onRunwayWind without recomputing computeRunwayWind() a second time.
  const allRunwayWindEnds = runways.flatMap((rwy) => computeRunwayWind(rwy.thresholds, surfaceWind))

  // Runway shown on the Wx-tab compass — user-selected via selectedRunwayDesig
  // (see the picker rendered in the Wx tab below), otherwise the longest
  // runway (most likely to be in active use). Deliberately NOT auto-picking
  // whichever runway has the better wind component across the whole
  // airport: which runway to actually use depends on more than wind alone
  // (surface, length, lighting, NOTAMs, traffic pattern, etc.) -- that's a
  // pilot judgement call, not something to imply via auto-selection. The
  // favoured-END highlight below stays scoped to whichever runway is
  // currently shown (computeRunwayWind's own within-runway comparison),
  // which is unambiguous regardless of which runway that is. Needs a
  // resolvable bearing on at least one threshold to be drawable at all --
  // see effectiveMagBrg's doc comment for why mag_brg can't be read
  // directly (0 placeholder).
  const longestRunway = [...runways].sort((a, b) => (b.length_m ?? 0) - (a.length_m ?? 0))[0]
  const compassRunway = selectedRunwayDesig != null
    ? runways.find((r) => r.designator === selectedRunwayDesig) ?? longestRunway
    : longestRunway

  // Favoured end of whichever runway is currently shown on the compass --
  // scoped to that one runway's own two ends (computeRunwayWind's normal
  // behaviour), not compared against any other runway at this airport.
  const compassRunwayWindEnds = compassRunway ? computeRunwayWind(compassRunway.thresholds, surfaceWind) : []
  const compassFavoredEnd = compassRunwayWindEnds.find((e) => e.favored) ?? null

  const primaryRunwayHeading: RunwayHeading | null = (() => {
    if (!compassRunway) return null
    const [t0, t1] = compassRunway.thresholds
    if (!t0) return null
    const brg = effectiveMagBrg(t0.mag_brg, t0.true_brg)
    if (brg == null) return null
    return { designators: [t0.designator, t1?.designator ?? '—'], headingDeg: brg }
  })()

  // Push the favored/severity state up to MapView so 'runway-threshold-label'
  // can highlight the same favored end on the map itself, not just here.
  // Cleanup clears the highlight on unmount (popup closed / different
  // aerodrome selected) so it never lingers after this popup goes away.
  useEffect(() => {
    if (!onRunwayWind) return
    const withWind = allRunwayWindEnds.filter((e) => e.headwindKt != null)
    onRunwayWind(p.icao, withWind)
    return () => onRunwayWind(p.icao, [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.icao, JSON.stringify(allRunwayWindEnds)])

  function toggleNotam(id: string) {
    setExpandedNotams((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const elevFt = p.elevation_ft ?? 0
  const oat    = parseFloat(oatStr)
  const qnh    = parseFloat(qnhStr)

  // Pressure altitude (ft) from QNH
  const pressAltFt = !isNaN(qnh) && qnh > 0
    ? elevFt + 30 * (1013.25 - qnh)
    : null

  // ISA temperature at pressure altitude
  const isaTempC = pressAltFt != null
    ? 15 - 1.98 * (pressAltFt / 1000)
    : null

  // Density altitude (ft)
  const densityAltFt = pressAltFt != null && !isNaN(oat) && isaTempC != null
    ? Math.round(pressAltFt + 120 * (oat - isaTempC))
    : null

  // Colour: green = near field elevation, yellow = +500 ft, red = +1000 ft
  function daColour(da: number): string {
    const delta = da - elevFt
    if (delta >= 1000) return 'var(--status-danger)'
    if (delta >= 500)  return 'var(--status-warn)'
    return 'var(--accent-green)'
  }

  return (
    <div className={css.panel}>
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className={css.header}>
          <div className={css.icao}>{p.icao || '—'}</div>
          <div className={css.nameLine}>
            <div className={css.name}>{p.name}</div>
            {p.elevation_ft != null && (
              <div className={css.elev}>{p.elevation_ft} ft AMSL</div>
            )}
            <div className={css.badges}>
              {p.type === 'HP' && <span className={css.badge}>Heliport</span>}
              {atc && (
                <span
                  className={`${css.badge} ${css[atc.status === 'open' ? 'atcOpen' : atc.status === 'closed' ? 'atcClosed' : 'atcUnknown']}`}
                  title={atc.status === 'unknown' ? 'No usable schedule data' : 'Based on published AIP hours (UTC)'}
                >
                  ATC {atc.status === 'open' ? 'Open' : atc.status === 'closed' ? 'Closed' : '?'}
                </span>
              )}
              {p.ppr && <span className={`${css.badge} ${css.ppr}`}>PPR</span>}
              {hasFuel &&
                fuelList.map((f) => (
                  <span key={f} className={`${css.badge} ${css.fuel}`}>
                    {fuelBadge(f)}
                  </span>
                ))}
            </div>
            {notamAtcHint && (
              <div className={css.notamHint}>⚠ Active NOTAM may affect ATC/tower — check NOTAMs tab</div>
            )}
            {notamHoursHint && (
              <div className={css.notamHint}>⏰ Active NOTAM may have changed opening hours — check NOTAMs tab</div>
            )}
          </div>
          <button
            className={`${css.homeBtn} ${isHome ? css.homeBtnActive : ''}`}
            onClick={() => onSetHome(p.icao, p.name, lng, lat)}
            title={isHome ? 'Home airfield' : 'Set as home airfield'}
            aria-label={isHome ? 'Home airfield' : 'Set as home airfield'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill={isHome ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          </button>
          <button className={css.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* ── Tab bar ─────────────────────────────────────────────────── */}
        <div className={css.tabBar}>
          <button
            className={`${css.tab} ${activeTab === 'info' ? css.tabActive : ''}`}
            onClick={() => setActiveTab('info')}
          >
            Info
          </button>
          <button
            className={`${css.tab} ${activeTab === 'wx' ? css.tabActive : ''}`}
            onClick={() => setActiveTab('wx')}
          >
            {metar?.flightRule
              ? <><span className={`${css.frDot} ${css[`frDot${metar.flightRule}`]}`} />Wx</>
              : 'Wx'
            }
          </button>
          <button
            className={`${css.tab} ${activeTab === 'notam' ? css.tabActive : ''}`}
            onClick={() => setActiveTab('notam')}
          >
            NOTAMs
            {!notamLoading && notams.length > 0 && (
              <span className={css.notamCount}>{notams.length}</span>
            )}
          </button>
        </div>

        {/* ── Info tab ────────────────────────────────────────────────── */}
        {activeTab === 'info' && (
          <>
            {/* Sunrise / Sunset */}
            <div className={css.section}>
              <div className={css.sectionTitle}>Sun (UTC)</div>
              <div className={css.sunRow}>
                <span className={css.sunLabel}>Sunrise</span>
                <span className={css.sunVal}>{fmtSunTime(sunTimes.rise)}</span>
                <span className={css.sunLabel}>Sunset</span>
                <span className={css.sunVal}>{fmtSunTime(sunTimes.set)}</span>
              </div>
            </div>

            {/* ATC Frequencies */}
            {freqs.length > 0 && (
              <div className={css.section}>
                <div className={css.sectionTitle}>Frequencies</div>
                <table className={css.freqTable}>
                  <tbody>
                    {freqs.map((f, i) => (
                      <tr key={i}>
                        <td className={css.freqType}>{serviceLabel(f.service)}</td>
                        <td className={css.freqMhz}>{f.freq_mhz.toFixed(3)}</td>
                        <td className={css.freqCallsign}>{f.callsign}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Runways */}
            {runways.length > 0 && (
              <div className={css.section}>
                <div className={css.sectionTitle}>Runways</div>
                {runways.map((rwy) => {
                  const magBrgs = rwy.thresholds
                    .map((t) => {
                      const brg = effectiveMagBrg(t.mag_brg, t.true_brg)
                      return brg != null ? `${brg}°` : null
                    })
                    .filter(Boolean)
                    .join(' / ')
                  const dims =
                    rwy.length_m != null
                      ? `${rwy.length_m}×${rwy.width_m ?? '?'}m`
                      : ''
                  const lighting = rwy.lighting ?? []
                  const vasi = rwy.visual_approach_aids ?? []
                  const declared = fmtDeclaredDistances(rwy.declared_distances)
                  const windEnds = computeRunwayWind(rwy.thresholds, surfaceWind)
                  const hasWind = windEnds.some((e) => e.headwindKt != null)
                  return (
                    <div key={rwy.designator} className={css.rwyBlock}>
                      <div className={css.rwyRow}>
                        <span className={css.rwyDesigGroup}>
                          {windEnds.map((e, i) => (
                            <span key={e.designator} style={{ display: 'flex', alignItems: 'center' }}>
                              {i > 0 && <span className={css.rwySlash}>/</span>}
                              <span
                                className={`${css.rwyDesig} ${e.crosswindSeverity ? css[`rwyDesig${e.crosswindSeverity === 'strong' ? 'Strong' : e.crosswindSeverity === 'moderate' ? 'Moderate' : 'Calm'}`] : ''} ${e.favored ? css.rwyDesigFavored : ''}`}
                                title={
                                  e.headwindKt != null
                                    ? `${e.headwindKt >= 0 ? `${e.headwindKt}kt headwind` : `${-e.headwindKt}kt tailwind`} · ${e.crosswindKt}kt crosswind`
                                    : undefined
                                }
                              >
                                {e.designator}
                              </span>
                            </span>
                          ))}
                        </span>
                        <span className={css.rwyDetail}>
                          {dims}
                          {dims && surfaceLabel(rwy.surface) ? ' · ' : ''}
                          {surfaceLabel(rwy.surface)}
                          {magBrgs ? ` · ${magBrgs}` : ''}
                        </span>
                      </div>
                      {hasWind && (
                        <div className={css.rwyWindRow}>
                          {windEnds.map((e) => e.headwindKt != null && (
                            <span key={e.designator}>
                              {e.designator}: {e.headwindKt >= 0 ? `${e.headwindKt}kt HW` : `${-e.headwindKt}kt TW`} · {e.crosswindKt}kt XW
                            </span>
                          ))}
                        </div>
                      )}
                      {(lighting.length > 0 || vasi.length > 0) && (
                        <div className={css.rwyBadges}>
                          {vasi.map((v) => (
                            <span key={v} className={css.rwyBadge}>{VASI_LABEL[v] ?? v}</span>
                          ))}
                          {lighting.map((l) => (
                            <span key={l} className={css.rwyBadge}>{LIGHTING_LABEL[l] ?? l}</span>
                          ))}
                        </div>
                      )}
                      {declared && (
                        <div className={css.rwyDeclared}>{declared} m</div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Hours of operation */}
            {hours.length > 0 && (
              <div className={css.section}>
                <div className={css.sectionTitle}>Hours of Operation</div>
                {hours.map((h, i) => (
                  <div key={i} className={css.hoursRow}>
                    <span>{fmtHoursEntry(h)}</span>
                    {h.remarks && <span className={css.hoursRemark}>{h.remarks}</span>}
                  </div>
                ))}
              </div>
            )}

            {/* Handling / passenger facilities */}
            {(handling.length > 0 || passenger.length > 0) && (
              <div className={css.section}>
                <div className={css.sectionTitle}>Facilities</div>
                <div className={css.rwyBadges}>
                  {handling.map((h) => (
                    <span key={h} className={css.rwyBadge}>{HANDLING_LABEL[h] ?? h}</span>
                  ))}
                  {passenger.map((p2) => (
                    <span key={p2} className={css.rwyBadge}>{PASSENGER_LABEL[p2] ?? p2}</span>
                  ))}
                </div>
              </div>
            )}

            {/* PPR Remarks */}
            {p.ppr && remarks.length > 0 && (
              <div className={css.section}>
                <div className={css.sectionTitle}>PPR / Restrictions</div>
                {remarks.map((r, i) => (
                  <div key={i} className={css.remark}>{r}</div>
                ))}
              </div>
            )}

            {/* Contacts */}
            {contacts.length > 0 && (
              <div className={css.section}>
                <div className={css.sectionTitle}>Contact</div>
                {contacts.map((c, i) => {
                  const label = CONTACT_LABEL[c.type] ?? c.type
                  let addressNode: React.ReactNode = c.address
                  if (c.type === 'URL') {
                    const href = c.address.startsWith('http')
                      ? c.address
                      : `https://${c.address}`
                    addressNode = (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {c.address}
                      </a>
                    )
                  } else if (c.type === 'PHONE' || c.type === 'PHONE-MET') {
                    addressNode = (
                      <a href={`tel:${c.address.replace(/\s/g, '')}`}>{c.address}</a>
                    )
                  } else if (c.type === 'EMAIL') {
                    addressNode = (
                      <a href={`mailto:${c.address}`}>{c.address}</a>
                    )
                  }
                  return (
                    <div key={i} className={css.contactRow}>
                      <span className={css.contactType}>{label}</span>
                      <span className={css.contactAddress}>{addressNode}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {/* ── Wx tab ──────────────────────────────────────────────────── */}
        {activeTab === 'wx' && (
          <>
            {/* Density Altitude */}
            <div className={css.section}>
              <div className={css.sectionTitle}>Density Altitude</div>
              <div className={css.daRow}>
                <label className={css.daLabel}>OAT</label>
                <input
                  className={css.daInput}
                  type="number"
                  placeholder="°C"
                  value={oatStr}
                  onChange={e => setOatStr(e.target.value)}
                />
                <label className={css.daLabel}>QNH</label>
                <input
                  className={css.daInput}
                  type="number"
                  placeholder={metar?.qnh ? metar.qnh.slice(1) : 'hPa'}
                  value={qnhStr}
                  onChange={e => setQnhStr(e.target.value)}
                />
              </div>
              {densityAltFt != null ? (
                <div className={css.daResult} style={{ color: daColour(densityAltFt) }}>
                  {densityAltFt.toLocaleString()} ft
                  <span className={css.daResultLabel}>density alt</span>
                  {pressAltFt != null && (
                    <span className={css.daPressAlt}>PA {Math.round(pressAltFt).toLocaleString()} ft</span>
                  )}
                </div>
              ) : pressAltFt != null ? (
                <div className={css.daHint}>
                  PA {Math.round(pressAltFt).toLocaleString()} ft — enter OAT for density alt
                </div>
              ) : (
                <div className={css.daHint}>Enter QNH and OAT</div>
              )}
            </div>

            {/* METAR / TAF */}
            <div className={css.section}>
              <div className={css.wxHeader}>
                <div className={css.sectionTitle}>Weather</div>
                {metar?.flightRule && (
                  <span className={`${css.frBadge} ${css[`fr${metar.flightRule}`]}`}>
                    {metar.flightRule}
                  </span>
                )}
                {metar?.time && (
                  <span className={css.wxTime}>
                    {metar.time}{fmtObsAge(metar.obsMs) ? ` · ${fmtObsAge(metar.obsMs)}` : ''}
                  </span>
                )}
              </div>

              {wxLoading && <div className={css.wxState}>Loading…</div>}
              {wxError && <div className={css.wxState}>{wxError}</div>}
              {!wxLoading && !wxError && !wx?.metar && !wx?.taf && !wx?.modelWind && (
                <div className={css.wxState}>No weather data at {p.icao} or any nearby station</div>
              )}

              {/* Nearest-station fallback banner -- shown whenever the data
                  displayed came from a different aerodrome than this one
                  (p.icao has no METAR/TAF of its own). */}
              {usingFallbackWx && wx && (
                <div className={css.wxFallback}>
                  No local report for <strong>{p.icao}</strong> — showing{' '}
                  <strong>{wx.sourceIcao}</strong>{wxSourceName ? ` (${wxSourceName})` : ''}
                  {wx.distNm != null ? `, ${Math.round(wx.distNm)} NM away` : ''}
                </div>
              )}

              {/* No real METAR/TAF anywhere within the search radius --
                  fall back to Open-Meteo's model wind at this aerodrome's
                  own coordinates (see fetchWxResolved) instead of showing
                  nothing. Clearly labelled as modelled, not observed --
                  never presented as if it were a real station report, and
                  no vis/ceiling/cloud/QNH/temperature tiles since the model
                  has no opinion on those (wind only). */}
              {!wxLoading && !wxError && !wx?.metar && !wx?.taf && wx?.modelWind && (
                <>
                  <div className={css.wxFallback}>
                    No METAR/TAF at <strong>{p.icao}</strong> or any nearby station — showing
                    modelled wind (Open-Meteo forecast, not an observation)
                  </div>
                  <div className={css.gaugeRow}>
                    <WindCompassGauge wind={modelWind} runway={primaryRunwayHeading} tone={windTone(modelWind)} />
                    <WindSpeedGauge wind={modelWind} tone={windTone(modelWind)} />
                  </div>
                </>
              )}

              {metar && (
                <>
                  {/* Runway picker — only shown when there's an actual choice
                      to make (multi-runway airports, e.g. ESMS 17/35 + 11/29).
                      Single-runway airports keep the compass always showing
                      their one runway with no selector clutter.
                      Deliberately doesn't recommend one RUNWAY over another
                      — that depends on more than wind alone (surface, length,
                      lighting, NOTAMs, traffic pattern), a pilot judgement
                      call this picker shouldn't imply an answer to. Only the
                      favoured END of whichever runway is currently shown
                      gets highlighted (on the compass below), scoped to that
                      one runway's own two ends. */}
                  {runways.length > 1 && (
                    <div className={css.rwyPicker}>
                      {[...runways].sort((a, b) => (b.length_m ?? 0) - (a.length_m ?? 0)).map((rwy) => {
                        const isSelected = compassRunway?.designator === rwy.designator
                        return (
                          <button
                            key={rwy.designator}
                            className={`${css.rwyPickerBtn} ${isSelected ? css.rwyPickerBtnActive : ''}`}
                            onClick={() => setSelectedRunwayDesig(rwy.designator)}
                          >
                            {rwy.designator}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {/* Graphical wind-direction/runway compass + speed dial */}
                  <div className={css.gaugeRow}>
                    <WindCompassGauge
                      wind={surfaceWind}
                      runway={primaryRunwayHeading}
                      tone={windTone(surfaceWind)}
                      favoredEndDesignator={compassFavoredEnd?.designator ?? null}
                    />
                    <WindSpeedGauge wind={surfaceWind} tone={windTone(surfaceWind)} />
                  </div>

                  {/* Colour-coded metric tiles — mirrors a public METAR/TAF
                      site's at-a-glance tile grid, but each tile's colour is
                      driven by its own metric threshold (not one shared
                      flight-rule colour for the whole card). */}
                  <div className={css.wxTileGrid}>
                    <div className={`${css.wxTile} ${css[`wxTile${windTone(surfaceWind)}`]}`}>
                      <span className={css.wxTileLabel}>Wind</span>
                      <span className={css.wxTileValue}>
                        {surfaceWind && !surfaceWind.calm && surfaceWind.dirDeg != null && (
                          <svg className={css.windArrow} viewBox="0 0 24 24" style={{ transform: `rotate(${surfaceWind.dirDeg + 180}deg)` }}>
                            <path d="M12 2 L18 14 L12 10.5 L6 14 Z" />
                          </svg>
                        )}
                        {fmtWind(surfaceWind)}
                      </span>
                    </div>
                    <div className={`${css.wxTile} ${css[`wxTile${visTone(metar.visM)}`]}`}>
                      <span className={css.wxTileLabel}>Visibility</span>
                      <span className={css.wxTileValue}>{fmtVis(metar.visM)}</span>
                    </div>
                    <div
                      className={`${css.wxTile} ${css[`wxTile${ceilingTone(metar.ceilingFt)}`]}`}
                      title={metar.ceilingFt == null && metar.clouds && metar.clouds !== 'CAVOK' ? 'No BKN/OVC layer reported — FEW/SCT clouds don’t count as a ceiling' : undefined}
                    >
                      <span className={css.wxTileLabel}>Ceiling</span>
                      <span className={css.wxTileValue}>{metar.ceilingFt != null ? `${metar.ceilingFt.toLocaleString()} ft` : metar.clouds === 'CAVOK' ? 'CAVOK' : 'No ceiling'}</span>
                    </div>
                    <div className={`${css.wxTile} ${css.wxTileinfo}`}>
                      <span className={css.wxTileLabel}>QNH</span>
                      <span className={css.wxTileValue}>{metar.qnh ? metar.qnh.slice(1) : '—'}</span>
                    </div>
                    {metar.temp && (
                      <div className={`${css.wxTile} ${css.wxTileinfo}`}>
                        <span className={css.wxTileLabel}>T / Td</span>
                        <span className={css.wxTileValue}>{metar.temp.replace('/', ' / ')}°C</span>
                      </div>
                    )}
                    {metar.wx && (
                      <div className={`${css.wxTile} ${css.wxTilewarn}`}>
                        <span className={css.wxTileLabel}>Wx</span>
                        <span className={css.wxTileValue}>{metar.wx}</span>
                      </div>
                    )}
                  </div>

                  {/* Cloud layers plotted on an altitude scale, lowest first */}
                  {metar.clouds && metar.clouds !== 'CAVOK' && (
                    <CloudProfile clouds={parseMetarClouds(metar.clouds)} />
                  )}

                  {/* Plain-English narrative — same purpose as a public
                      METAR/TAF site's translated-to-prose summary. */}
                  <p className={css.wxNarrative}>
                    {metarNarrative(metar).join(' ')}
                  </p>
                </>
              )}

              {wx?.metar && (
                <div className={css.metarRaw} title="Raw METAR">{wx.metar}</div>
              )}

              {wx?.taf && (
                <div className={css.tafBlock}>
                  <button
                    className={css.tafToggle}
                    onClick={() => setTafExpanded((v) => !v)}
                    aria-expanded={String(tafExpanded) as 'true' | 'false'}
                  >
                    TAF {tafExpanded ? '▴' : '▾'}
                  </button>
                  {tafExpanded && (
                    <>
                      {tafPeriods && tafPeriods.length > 0 && (
                        <TafTimeline periods={tafPeriods} lat={lat} lng={lng} />
                      )}
                      {tafPeriods && tafPeriods.length > 0 && (
                        <div className={css.tafPeriods}>
                          <div className={css.tafPeriodsLabel}>Change groups</div>
                          {tafPeriods.map((period, i) => (
                            <div key={i} className={css.tafPeriod}>
                              <div className={css.tafPeriodHead}>
                                <span className={css.tafPeriodKind}>{TAF_PERIOD_LABEL[period.kind] ?? period.kind}</span>
                                <span className={css.tafPeriodTime}>{fmtTafTime(period.fromMs)} – {fmtTafTime(period.toMs)}</span>
                              </div>
                              <div className={css.tafPeriodBody}>
                                {period.wind && <span>{fmtWind(period.wind)}</span>}
                                <span>{fmtTafClouds(period.clouds)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <pre className={css.tafRaw}>{wx.taf}</pre>
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── NOTAMs tab ──────────────────────────────────────────────── */}
        {activeTab === 'notam' && (
          <div className={css.section}>
            <div className={css.sectionTitle}>NOTAMs</div>
            {notamLoading && <div className={css.wxState}>Loading…</div>}
            {notamError && <div className={css.wxState}>{notamError}</div>}
            {!notamLoading && !notamError && notams.length === 0 && (
              <div className={css.wxState}>No active NOTAMs</div>
            )}
            {notams.map((n) => {
              const expanded = expandedNotams.has(n.id)
              const eff  = fmtNotamDate(n.effective)
              const exp  = fmtNotamDate(n.expires)
              return (
                <div key={n.id} className={css.notamItem}>
                  <button
                    className={css.notamToggle}
                    onClick={() => toggleNotam(n.id)}
                    aria-expanded={String(expanded) as 'true' | 'false'}
                  >
                    <span className={css.notamId}>{n.id}</span>
                    {eff && <span className={css.notamPeriod}>{eff}{exp ? ` – ${exp}` : ''}</span>}
                    <span className={css.notamChevron}>{expanded ? '▴' : '▾'}</span>
                  </button>
                  {expanded && (
                    <pre className={css.notamText}>{n.text}</pre>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
  )
}
