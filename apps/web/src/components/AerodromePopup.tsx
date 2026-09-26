import { useState, useEffect } from 'react'
import css from './AerodromePopup.module.css'
import { notamTitle } from '@open-vfr/shared/notamQCode'
import { buildAerodromeLink } from '@open-vfr/shared/deepLink'
import { fetchWxResolved, decodeMetar, parseMetarWind, parseMetarClouds, type WxResolved, type WxStationCandidate, type ParsedWind } from '../utils/fetchWx'
import { fetchAmbientWx, type AmbientWx } from '@open-vfr/shared/fetchWind'
import { parseTaf, type TafPeriod } from '@open-vfr/shared/parseTaf'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { computeRunwayWind, effectiveMagBrg, type RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import { WindCompassGauge, WindSpeedGauge, type RunwayHeading } from './WindGauges'
import { visTone, ceilingTone, windTone, fmtVis, fmtWind, fmtObsAge, metarNarrative } from '@open-vfr/shared/wxFormat'
import TafTimeline from './TafTimeline'
import CloudProfile from './CloudProfile'
import { fetchNotams, fmtNotamDate, type NotamItem } from '../utils/fetchNotam'
import { filterNotamsNearRoute, filterAndSortNotamsNearRoute, DEFAULT_ROUTE_NOTAM_BUFFER_NM, DEFAULT_VICINITY_NOTAM_NM, type RoutePoint } from '@open-vfr/shared/notamRouteFilter'
import { printBriefingDoc } from '../utils/printBriefing'
import { notamText } from '@open-vfr/shared/notamIcaoFormat'
import { applyNotamRelevance, relevantFirPrefixes, relevanceHiddenNote } from '@open-vfr/shared/notamRelevance'
import { useNotamPrefs } from '../hooks/useNotamPrefs'
import NotamViewControls from './NotamViewControls'
import ctlCss from './NotamViewControls.module.css'
import RegionalNotamsPanel from './RegionalNotamsPanel'
import { sunriseSunset, fmtSunTime } from '../utils/sunCalc'
import { computeAtcStatus, anyNotamAtcRelated, anyNotamHoursChangeRelated } from '@open-vfr/shared/atcStatus'
import { API_BASE_URL, TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'
import { loadStations as loadStationsShared, type StationRecord } from '@open-vfr/shared/wxStations'

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

/** Share (native share sheet) or copy a link that opens this aerodrome.
 *  navigator.share rejects with AbortError when the user cancels the sheet
 *  -- that's not a failure, so no clipboard fallback in that case. */
function ShareAerodromeButton({ icao, name }: { icao: string; name: string }) {
  const [copied, setCopied] = useState(false)
  if (!icao) return null
  const onShare = async () => {
    const url = buildAerodromeLink(`${window.location.origin}${window.location.pathname}`, icao)
    if (typeof navigator.share === 'function') {
      try { await navigator.share({ title: `${icao} ${name}`.trim(), url }); return }
      catch (e) { if ((e as DOMException)?.name === 'AbortError') return }
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked (insecure context / permissions) */ }
  }
  return (
    <button
      className={css.homeBtn}
      onClick={onShare}
      title={copied ? 'Link copied' : 'Share link to this aerodrome'}
      aria-label="Share link to this aerodrome"
    >
      {copied ? '✓' : (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
          <line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/>
        </svg>
      )}
    </button>
  )
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
  /**
   * Embeds just one tab's content, no header/tab-bar/Info tab -- mirrors
   * native's AerodromeWxSection/AerodromeNotamSection extraction, reused
   * by VicinityBriefPanel.tsx's own Weather/NOTAMs tabs (which already show
   * the ICAO + distance via their own aerodrome-picker chip, and have their
   * own outer close button) instead of duplicating this component's Wx/
   * NOTAM rendering into separate files the way native did. Undefined =
   * normal standalone popup (map click / feature info panel), unchanged.
   */
  forcedTab?: 'wx' | 'notam'
  /**
   * FIR-wide NOTAMs (unfiltered -- filtering to the planned route, when one
   * exists, happens in here) + the route itself, rendered as an "Other
   * NOTAMs" section below this aerodrome's own NOTAM list (same
   * RegionalNotamsPanel used by VicinityBriefPanel.tsx's own NOTAMs tab --
   * single shared implementation, not two). Undefined = section omitted
   * (e.g. a context with no regional-NOTAM feed wired up), matching the
   * pre-existing behaviour.
   */
  regionalNotams?: NotamItem[]
  routeWaypoints?: RoutePoint[]
  onShowNotamOnMap?: (notam: NotamItem) => void
}

// ── Nearby-station cache (for METAR/TAF fallback) ─────────────────────────────
// Minimal {icao,name,lat,lng} index of every aerodrome, loaded once via
// @open-vfr/shared/wxStations (shared with native's own AerodromePopup) and
// cached by URL -- see that module's doc comment.

function loadStations(): Promise<StationRecord[]> {
  return loadStationsShared(versionedTileUrl(TILES_BASE_URL, 'se-aerodromes.geojson')).catch(() => [])
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

export default function AerodromePopup({
  props: p, lng, lat, isHome, authed, onSetHome, onClose, onRunwayWind, forcedTab,
  regionalNotams, routeWaypoints, onShowNotamOnMap,
}: Props) {
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
  // `forcedTab` (Vicinity Brief embed) always overrides internal tab state --
  // that embed's own outer tab bar drives which section shows, this
  // component's own tab bar/Info tab don't render there at all (see
  // `forcedTab`'s own doc comment on Props).
  const effectiveTab = forcedTab ?? activeTab

  // "Other NOTAMs" (FIR-wide, not tied to this aerodrome) -- see
  // regionalNotams' own Props doc comment. Filtered to route proximity
  // exactly like VicinityBriefPanel.tsx used to do for its own now-removed
  // separate RegionalNotamsPanel call; RegionalNotamsPanel itself handles
  // the along-route sort via routeWaypoints.
  const hasRegionalNotamRoute = !!routeWaypoints && routeWaypoints.length > 0
  const displayedRegionalNotams = regionalNotams === undefined
    ? undefined
    : hasRegionalNotamRoute
      ? filterNotamsNearRoute(regionalNotams, routeWaypoints!, DEFAULT_ROUTE_NOTAM_BUFFER_NM)
      // No route: this aerodrome's vicinity, not the whole FIR-wide list
      // (thousands of entries from across Europe) -- same scope as the
      // printed briefing. NOTAMs without a position pass this distance
      // filter and are scoped by FIR in the relevance step below.
      : filterAndSortNotamsNearRoute(regionalNotams, [{ lat, lng }], DEFAULT_VICINITY_NOTAM_NM)


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

  // ── Weather: METAR (own icao, auto-falls back to nearest station) vs
  //    Weather station (Open-Meteo, non-aviation, always available) ─────
  // Two independent sources fetched in parallel, toggled between rather
  // than blended -- see AGENTS.md's "Wx tab METAR/weather-station toggle"
  // gotcha for why they're never merged into one derived object.
  const [wx, setWx] = useState<WxResolved | null>(null)
  const [wxLoading, setWxLoading] = useState(true)
  const [wxError, setWxError] = useState<string | null>(null)
  const [tafExpanded, setTafExpanded] = useState(false)
  // Name of the fallback station (wx.sourceIcao), when different from p.icao.
  const [wxSourceName, setWxSourceName] = useState<string | null>(null)
  // Open-Meteo ambient reading at this aerodrome's own coordinates --
  // always fetched regardless of METAR availability/auth, so the Weather
  // station tab is ready the instant it's selected. Null while loading or
  // if the Open-Meteo request itself failed (offline/outage).
  const [ambientWx, setAmbientWx] = useState<AmbientWx | null>(null)
  // Which tab is displayed. Auto-defaults to 'metar'; auto-switches to
  // 'station' once the METAR search comes back completely empty (see fetch
  // effect below). User clicks override and persist until the aerodrome
  // changes (p.icao effect resets to 'metar').
  const [wxSource, setWxSource] = useState<'metar' | 'station'>('metar')

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
    setAmbientWx(null); setWxSource('metar')
    setNotams([]); setNotamLoading(true); setNotamError(null)
    setTafExpanded(false); setExpandedNotams(new Set())

    // Weather station (Open-Meteo) tier -- always fetched, independent of
    // sign-in/METAR search below, so it's ready the instant the user
    // toggles to it even when a real METAR/TAF also exists.
    fetchAmbientWx(lat, lng, API_BASE_URL, ac.signal)
      .then((data) => { if (!ac.signal.aborted) setAmbientWx(data) })
      .catch((err) => { if ((err as Error).name !== 'AbortError') { /* leave ambientWx null -- "no data" state */ } })

    if (!authed) {
      // Not signed in — server requires auth for METAR/NOTAM, skip the
      // guaranteed 401 (Weather station above doesn't need auth).
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
          // No METAR/TAF anywhere -- default to the Weather station tab
          // instead of an empty METAR panel. A user click before this
          // resolves can still be overridden here (rare race, low stakes).
          if (!data.metar && !data.taf) setWxSource('station')
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

  // Selected tab's decoded METAR -- everything metar-tile-grid/TAF/cloud-
  // profile-related below derives from this, null when the Weather station
  // tab is selected (that tab renders from ambientWx instead, further down).
  const metar = wx?.metar ? decodeMetar(wx.metar) : null
  const surfaceWind = metar ? parseMetarWind(metar.wind) : null
  // Open-Meteo ambient reading (fetchAmbientWx), reshaped into the same
  // ParsedWind the compass/speed gauge/windTone/fmtWind already know how to
  // render. Always modelled/forecast, never an observation.
  const ambientWind: ParsedWind | null = ambientWx
    ? { dirDeg: ambientWx.dirDeg, speedKt: ambientWx.speedKts, gustKt: ambientWx.gustKts, variable: false, calm: ambientWx.speedKts === 0 }
    : null
  // The wind actually used everywhere a runway/wind-relative computation
  // needs "the wind for this aerodrome" -- compass, speed dial, Wind tile,
  // AND the favoured-runway-end highlight (both here and on the map via
  // onRunwayWind below). Whichever tab is selected supplies it: the real
  // METAR's own wind for 'metar' (however far away that station is -- the
  // fallback-distance banner tells the pilot to judge staleness themselves,
  // no silent auto-swap to modelled wind), Open-Meteo's ambient wind for
  // 'station'.
  const effectiveWind = wxSource === 'station' ? ambientWind : surfaceWind
  const windIsModelled = wxSource === 'station'
  const tafPeriods: TafPeriod[] | null = wx?.taf ? parseTaf(wx.taf) : null
  const usingFallbackWx = !!wx && wx.sourceIcao !== p.icao

  // Flattened across all runways at this aerodrome, computed once here (not
  // inside the JSX .map() below) so it can also be reported to the map via
  // onRunwayWind without recomputing computeRunwayWind() a second time.
  const allRunwayWindEnds = runways.flatMap((rwy) => computeRunwayWind(rwy.thresholds, effectiveWind))

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
  const compassRunwayWindEnds = compassRunway ? computeRunwayWind(compassRunway.thresholds, effectiveWind) : []
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

  // Relevance filters (VFR-only preference; FIR scope for NOTAMs without a
  // usable position -- only FIRs this aerodrome / the route touch). See
  // @open-vfr/shared/notamRelevance. Own-aerodrome NOTAMs need no FIR scope.
  const { textView, vfrOnly, setVfrOnly } = useNotamPrefs()
  const firPrefixes = relevantFirPrefixes([{ lat, lng }, ...(routeWaypoints ?? [])], [p.icao])
  const ownRel = applyNotamRelevance(notams, { vfrOnly, firPrefixes: new Set() })
  const regRel = displayedRegionalNotams === undefined
    ? undefined
    : applyNotamRelevance(displayedRegionalNotams, { vfrOnly, firPrefixes })
  const ownHiddenNote = relevanceHiddenNote(ownRel)
  const regHiddenNote = regRel ? relevanceHiddenNote(regRel) : null

  return (
    <div className={css.panel}>
      {!forcedTab && (
      <>
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
          <ShareAerodromeButton icao={p.icao} name={p.name} />
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
              ? <><span className={`${css.frDot} ${css[`frDot${metar.flightRule}`]}`} />Weather</>
              : 'Weather'
            }
          </button>
          <button
            className={`${css.tab} ${activeTab === 'notam' ? css.tabActive : ''}`}
            onClick={() => setActiveTab('notam')}
          >
            NOTAMs
            {/* Counts what the tab will actually list (after the VFR-only
                filter), so the badge never promises NOTAMs the tab hides. */}
            {!notamLoading && ownRel.kept.length > 0 && (
              <span className={css.notamCount}>{ownRel.kept.length}</span>
            )}
          </button>
        </div>
        </>
      )}

        {/* ── Info tab ────────────────────────────────────────────────── */}
        {!forcedTab && activeTab === 'info' && (
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
                  const windEnds = computeRunwayWind(rwy.thresholds, effectiveWind)
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
        {effectiveTab === 'wx' && (
          <>
            {/* METAR / Weather station */}
            <div className={css.section}>
              <div className={css.wxHeader}>
                <div className={css.sectionTitle}>Weather</div>
                {wxSource === 'metar' && metar?.flightRule && (
                  <span className={`${css.frBadge} ${css[`fr${metar.flightRule}`]}`}>
                    {metar.flightRule}
                  </span>
                )}
                {wxSource === 'metar' && metar?.time && (
                  <span className={css.wxTime}>
                    {metar.time}{fmtObsAge(metar.obsMs) ? ` · ${fmtObsAge(metar.obsMs)}` : ''}
                  </span>
                )}
                {wxSource === 'station' && (
                  <span className={css.wxTime}>Modelled · now</span>
                )}
              </div>

              {wxLoading && <div className={css.wxState}>Loading…</div>}
              {wxError && <div className={css.wxState}>{wxError}</div>}

              {/* METAR / Weather station toggle -- always both offered.
                  METAR is p.icao's own report, auto-falling back to the
                  nearest reporting station when p.icao has none (see
                  fetchWxResolved, unchanged automatic behaviour). Weather
                  station is Open-Meteo's non-aviation ambient reading at
                  p.icao's own coordinates, always available regardless of
                  whether a real METAR exists anywhere. Picking either
                  drives everything below (metar/ambientWx, effectiveWind,
                  runway favoured-end, MapView's runway highlight) as one
                  unit -- see the derivations above this component's JSX. */}
              <div className={css.rwyPicker}>
                <button
                  className={`${css.rwyPickerBtn} ${css.wxSourceBtn} ${wxSource === 'metar' ? css.rwyPickerBtnActive : ''}`}
                  onClick={() => setWxSource('metar')}
                >
                  METAR
                </button>
                <button
                  className={`${css.rwyPickerBtn} ${css.wxSourceBtn} ${wxSource === 'station' ? css.rwyPickerBtnActive : ''}`}
                  onClick={() => setWxSource('station')}
                >
                  Weather station
                </button>
              </div>

              {wxSource === 'metar' && (
                <>
                  {!wxLoading && !wxError && !wx?.metar && !wx?.taf && (
                    <div className={css.wxState}>No METAR/TAF at {p.icao} or any nearby station — try Weather station above</div>
                  )}

                  {/* Fallback banner -- shown whenever the METAR/TAF shown
                      came from a different aerodrome than this one (p.icao
                      has no report of its own). Deliberately no silent
                      wind-only swap to modelled data at any distance
                      anymore -- that's what the Weather station tab is for;
                      this banner just tells the pilot how far away the
                      shown report actually is so they can judge relevance
                      themselves. */}
                  {usingFallbackWx && wx && (
                    <div className={css.wxFallback}>
                      Showing <strong>{wx.sourceIcao}</strong>{wxSourceName ? ` (${wxSourceName})` : ''}
                      {wx.distNm != null ? `, ${Math.round(wx.distNm)} NM away` : ''} — not {p.icao}'s own report
                    </div>
                  )}

                  {metar && (
                    <>
                      {/* Runway picker — only shown when there's an actual choice
                          to make (multi-runway airports, e.g. ESMS 17/35 + 11/29).
                          Single-runway airports keep the compass always showing
                          their one runway with no selector clutter.
                          Still doesn't recommend one RUNWAY over another outright
                          — that depends on more than wind alone (surface, length,
                          lighting, NOTAMs, traffic pattern), a pilot judgement
                          call this picker shouldn't make for them. It DOES give a
                          wind-only "suitable" cue though: just the specific END
                          digits (e.g. only "17" in "17/35", not the whole pill)
                          turn green when THAT end has a positive headwind and a
                          calm crosswind -- a runway has two ends and only one of
                          them is ever the one to actually use, so colouring the
                          whole pill would be misleading (implies both ends, or
                          the runway as a whole, are equally suitable). The
                          favoured END of whichever runway is currently shown is
                          separately highlighted on the compass below too. */}
                      {runways.length > 1 && (
                        <div className={css.rwyPicker}>
                          {[...runways].sort((a, b) => (b.length_m ?? 0) - (a.length_m ?? 0)).map((rwy) => {
                            const isSelected = compassRunway?.designator === rwy.designator
                            const windEnds = computeRunwayWind(rwy.thresholds, effectiveWind)
                            return (
                              <button
                                key={rwy.designator}
                                className={`${css.rwyPickerBtn} ${isSelected ? css.rwyPickerBtnActive : ''}`}
                                onClick={() => setSelectedRunwayDesig(rwy.designator)}
                              >
                                {rwy.thresholds.map((t, i) => {
                                  const end = windEnds.find((e) => e.designator === t.designator)
                                  const isSuitable = !!end?.favored && end.headwindKt != null && end.headwindKt >= 0 && end.crosswindSeverity === 'calm'
                                  return (
                                    <span key={t.designator}>
                                      {i > 0 && '/'}
                                      <span className={isSuitable ? css.rwyPickerDesigSuitable : undefined}>{t.designator}</span>
                                    </span>
                                  )
                                })}
                              </button>
                            )
                          })}
                        </div>
                      )}

                      {/* Graphical wind-direction/runway compass + speed dial,
                          driven by this METAR's own wind (see effectiveWind). */}
                      <div className={css.gaugeRow}>
                        <WindCompassGauge
                          wind={effectiveWind}
                          runway={primaryRunwayHeading}
                          tone={windTone(effectiveWind)}
                          favoredEndDesignator={compassFavoredEnd?.designator ?? null}
                        />
                        <WindSpeedGauge wind={effectiveWind} tone={windTone(effectiveWind)} />
                      </div>

                      {/* Colour-coded metric tiles — mirrors a public METAR/TAF
                          site's at-a-glance tile grid, but each tile's colour is
                          driven by its own metric threshold (not one shared
                          flight-rule colour for the whole card). */}
                      <div className={css.wxTileGrid}>
                        <div className={`${css.wxTile} ${css[`wxTile${windTone(effectiveWind)}`]}`}>
                          <span className={css.wxTileLabel}>Wind{windIsModelled ? ' (modelled)' : ''}</span>
                          <span className={css.wxTileValue}>
                            {effectiveWind && !effectiveWind.calm && effectiveWind.dirDeg != null && (
                              <svg className={css.windArrow} viewBox="0 0 24 24" style={{ transform: `rotate(${effectiveWind.dirDeg + 180}deg)` }}>
                                <path d="M12 2 L18 14 L12 10.5 L6 14 Z" />
                              </svg>
                            )}
                            {fmtWind(effectiveWind)}
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
                </>
              )}

              {wxSource === 'station' && (
                <>
                  {!ambientWx && (
                    <div className={css.wxState}>Weather station data unavailable (offline, or Open-Meteo outage)</div>
                  )}

                  {ambientWx && (
                    <>
                      <div className={css.wxFallback}>
                        Modelled (Open-Meteo forecast) at {p.icao}'s own coordinates — not an observed report.
                      </div>

                      {runways.length > 1 && (
                        <div className={css.rwyPicker}>
                          {[...runways].sort((a, b) => (b.length_m ?? 0) - (a.length_m ?? 0)).map((rwy) => {
                            const isSelected = compassRunway?.designator === rwy.designator
                            const windEnds = computeRunwayWind(rwy.thresholds, effectiveWind)
                            return (
                              <button
                                key={rwy.designator}
                                className={`${css.rwyPickerBtn} ${isSelected ? css.rwyPickerBtnActive : ''}`}
                                onClick={() => setSelectedRunwayDesig(rwy.designator)}
                              >
                                {rwy.thresholds.map((t, i) => {
                                  const end = windEnds.find((e) => e.designator === t.designator)
                                  const isSuitable = !!end?.favored && end.headwindKt != null && end.headwindKt >= 0 && end.crosswindSeverity === 'calm'
                                  return (
                                    <span key={t.designator}>
                                      {i > 0 && '/'}
                                      <span className={isSuitable ? css.rwyPickerDesigSuitable : undefined}>{t.designator}</span>
                                    </span>
                                  )
                                })}
                              </button>
                            )
                          })}
                        </div>
                      )}

                      <div className={css.gaugeRow}>
                        <WindCompassGauge
                          wind={effectiveWind}
                          runway={primaryRunwayHeading}
                          tone={windTone(effectiveWind)}
                          favoredEndDesignator={compassFavoredEnd?.designator ?? null}
                        />
                        <WindSpeedGauge wind={effectiveWind} tone={windTone(effectiveWind)} />
                      </div>

                      <div className={css.wxTileGrid}>
                        <div className={`${css.wxTile} ${css[`wxTile${windTone(effectiveWind)}`]}`}>
                          <span className={css.wxTileLabel}>Wind{windIsModelled ? ' (modelled)' : ''}</span>
                          <span className={css.wxTileValue}>
                            {effectiveWind && !effectiveWind.calm && effectiveWind.dirDeg != null && (
                              <svg className={css.windArrow} viewBox="0 0 24 24" style={{ transform: `rotate(${effectiveWind.dirDeg + 180}deg)` }}>
                                <path d="M12 2 L18 14 L12 10.5 L6 14 Z" />
                              </svg>
                            )}
                            {fmtWind(effectiveWind)}
                          </span>
                        </div>
                        {ambientWx.tempC != null && (
                          <div className={`${css.wxTile} ${css.wxTileinfo}`}>
                            <span className={css.wxTileLabel}>Temp</span>
                            <span className={css.wxTileValue}>{ambientWx.tempC}°C</span>
                          </div>
                        )}
                        {ambientWx.cloudPct != null && (
                          <div className={`${css.wxTile} ${css.wxTileinfo}`}>
                            <span className={css.wxTileLabel}>Cloud cover</span>
                            <span className={css.wxTileValue}>{ambientWx.cloudPct}%</span>
                          </div>
                        )}
                        {ambientWx.pressureHpa != null && (
                          <div className={`${css.wxTile} ${css.wxTileinfo}`} title="Station-level surface pressure -- not a sea-level-reduced QNH">
                            <span className={css.wxTileLabel}>Surface pressure</span>
                            <span className={css.wxTileValue}>{ambientWx.pressureHpa} hPa</span>
                          </div>
                        )}
                        {ambientWx.precipMm != null && ambientWx.precipMm > 0 && (
                          <div className={`${css.wxTile} ${css.wxTilewarn}`}>
                            <span className={css.wxTileLabel}>Precip</span>
                            <span className={css.wxTileValue}>{ambientWx.precipMm} mm</span>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
            {/* Density altitude -- moved below Weather; niche calc, not the
                reason most pilots open this tab, and its two inputs
                shouldn't push the actual METAR/TAF below the fold (mirrors
                native AerodromeWxSection.tsx's identical repositioning). */}
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
          </>
        )}

        {/* ── NOTAMs tab ──────────────────────────────────────────────── */}
        {effectiveTab === 'notam' && (
          <div className={css.section}>
            <div className={`${css.sectionTitle} ${css.sectionTitleRow}`}>
              <span>NOTAMs</span>
              {!notamLoading && !notamError && (
                <button
                  type="button"
                  className={css.printBtn}
                  title="Print or save a NOTAM briefing (PDF) for this aerodrome"
                  onClick={() => {
                    const regional = regRel?.kept ?? []
                    const hiddenNotes = [ownHiddenNote && `Aerodrome: ${ownHiddenNote}`, regHiddenNote && `Other: ${regHiddenNote}`].filter(Boolean)
                    const ok = printBriefingDoc({
                      title: `${p.icao} ${p.name}`.trim(),
                      textView,
                      note: [
                        vfrOnly ? 'Filter: VFR-relevant NOTAMs only.' : 'Filter: all NOTAMs including IFR-only.',
                        'NOTAMs without a position are limited to the FIRs this briefing covers.',
                        ...hiddenNotes,
                      ].join(' '),
                      sections: [
                        { heading: `${p.icao || 'Aerodrome'} NOTAMs`, notams: ownRel.kept },
                        ...(regRel !== undefined ? [
                          hasRegionalNotamRoute && routeWaypoints
                            ? {
                                heading: 'Other NOTAMs',
                                note: `Within ${DEFAULT_ROUTE_NOTAM_BUFFER_NM} NM of the planned route, in along-route order.`,
                                // already route-filtered upstream -- sort only
                                notams: filterAndSortNotamsNearRoute(regional, routeWaypoints, Infinity),
                              }
                            : {
                                heading: 'Other NOTAMs',
                                note: `Within ${DEFAULT_VICINITY_NOTAM_NM} NM of ${p.icao || 'the aerodrome'} (no route loaded).`,
                                notams: regional, // already vicinity-filtered and distance-sorted above
                              },
                        ] : []),
                      ],
                    })
                    if (!ok) window.alert('Allow pop-ups for this site to print the briefing.')
                  }}
                >
                  Print
                </button>
              )}
            </div>
            <div style={{ margin: '0 0 6px' }}><NotamViewControls /></div>
            {notamLoading && <div className={css.wxState}>Loading…</div>}
            {notamError && <div className={css.wxState}>{notamError}</div>}
            {!notamLoading && !notamError && ownRel.kept.length === 0 && (
              <div className={css.wxState}>No active NOTAMs</div>
            )}
            {ownRel.kept.map((n) => {
              // nmsId, not display id, for expand-state/React key -- see
              // apps/api/src/notam.ts's NotamItem.nmsId comment.
              const expanded = expandedNotams.has(n.nmsId)
              const eff  = fmtNotamDate(n.effective)
              const exp  = fmtNotamDate(n.expires)
              return (
                <div key={n.nmsId} className={css.notamItem}>
                  <button
                    className={css.notamToggle}
                    onClick={() => toggleNotam(n.nmsId)}
                    aria-expanded={String(expanded) as 'true' | 'false'}
                  >
                    <span className={css.notamId}>{notamTitle(n)}</span>
                    {eff && <span className={css.notamPeriod}>{eff}{exp ? ` – ${exp}` : ''}</span>}
                    <span className={css.notamChevron}>{expanded ? '▴' : '▾'}</span>
                  </button>
                  {expanded && (
                    <pre className={css.notamText}>{notamText(n, textView)}</pre>
                  )}
                </div>
              )
            })}
            {ownHiddenNote && (
              <div className={ctlCss.hiddenNote}>
                {ownHiddenNote}
                {ownRel.hiddenIfrOnly > 0 && <button onClick={() => setVfrOnly(false)}>Show IFR-only</button>}
              </div>
            )}
          </div>
        )}

        {/* "Other NOTAMs" -- FIR-wide, not tied to this aerodrome. Omitted
            entirely when regionalNotams isn't wired up (see Props' own doc
            comment). */}
        {effectiveTab === 'notam' && displayedRegionalNotams !== undefined && (
          <div className={css.section}>
            <div className={css.sectionTitle}>Other NOTAMs</div>
            {!hasRegionalNotamRoute && (
              <div className={ctlCss.hiddenNote}>Within {DEFAULT_VICINITY_NOTAM_NM} NM of {p.icao || 'this aerodrome'} (no route loaded)</div>
            )}
            <RegionalNotamsPanel
              notams={regRel?.kept ?? displayedRegionalNotams}
              routeFiltered={hasRegionalNotamRoute}
              bufferNm={DEFAULT_ROUTE_NOTAM_BUFFER_NM}
              routeWaypoints={routeWaypoints}
              onShowOnMap={onShowNotamOnMap}
            />
            {regHiddenNote && (
              <div className={ctlCss.hiddenNote}>
                {regHiddenNote}
                {(regRel?.hiddenIfrOnly ?? 0) > 0 && <button onClick={() => setVfrOnly(false)}>Show IFR-only</button>}
              </div>
            )}
          </div>
        )}
      </div>
  )
}
