import { useState, useEffect } from 'react'
import css from './AerodromePopup.module.css'
import { fetchWx, decodeMetar, parseMetarWind, type WxResult } from '../utils/fetchWx'
import { computeRunwayWind, type RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import { fetchNotams, fmtNotamDate, type NotamItem } from '../utils/fetchNotam'
import { sunriseSunset, fmtSunTime } from '../utils/sunCalc'
import { API_BASE_URL } from '../utils/env'

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

  // ── Sunrise / Sunset ─────────────────────────────────────────────────────
  const sunTimes = sunriseSunset(lat, lng)

  // ── Density altitude inputs ───────────────────────────────────────────────
  const [oatStr, setOatStr] = useState('')
  const [qnhStr, setQnhStr] = useState('')

  // ── Weather (METAR / TAF) ─────────────────────────────────────────────────
  const [wx, setWx] = useState<WxResult | null>(null)
  const [wxLoading, setWxLoading] = useState(true)
  const [wxError, setWxError] = useState<string | null>(null)
  const [tafExpanded, setTafExpanded] = useState(false)

  // ── NOTAMs ────────────────────────────────────────────────────────────────
  const [notams, setNotams] = useState<NotamItem[]>([])
  const [notamLoading, setNotamLoading] = useState(true)
  const [notamError, setNotamError] = useState<string | null>(null)
  const [expandedNotams, setExpandedNotams] = useState<Set<string>>(new Set())

  useEffect(() => {
    const ac = new AbortController()
    setWx(null); setWxLoading(true); setWxError(null)
    setNotams([]); setNotamLoading(true); setNotamError(null)
    setTafExpanded(false); setExpandedNotams(new Set())

    if (!authed) {
      // Not signed in — server requires auth for these, skip the guaranteed 401.
      setWxLoading(false); setNotamLoading(false)
      return () => ac.abort()
    }

    fetchWx(p.icao, API_BASE_URL, ac.signal)
      .then((data) => { setWx(data); setWxLoading(false) })
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') {
          setWxError('Weather unavailable')
          setWxLoading(false)
        }
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
  }, [p.icao, authed])

  const metar = wx?.metar ? decodeMetar(wx.metar) : null
  const surfaceWind = metar ? parseMetarWind(metar.wind) : null

  // Flattened across all runways at this aerodrome, computed once here (not
  // inside the JSX .map() below) so it can also be reported to the map via
  // onRunwayWind without recomputing computeRunwayWind() a second time.
  const allRunwayWindEnds = runways.flatMap((rwy) => computeRunwayWind(rwy.thresholds, surfaceWind))

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
              {p.ppr && <span className={`${css.badge} ${css.ppr}`}>PPR</span>}
              {hasFuel &&
                fuelList.map((f) => (
                  <span key={f} className={`${css.badge} ${css.fuel}`}>
                    {fuelBadge(f)}
                  </span>
                ))}
            </div>
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
                    .map((t) => (t.mag_brg != null ? `${t.mag_brg}°` : null))
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
              </div>
              {wxLoading && <div className={css.wxState}>Loading…</div>}
              {wxError && <div className={css.wxState}>{wxError}</div>}
              {!wxLoading && !wxError && !wx?.metar && !wx?.taf && (
                <div className={css.wxState}>No weather data</div>
              )}
              {metar && (
                <div className={css.wxGrid}>
                  {metar.wind && (
                    <><span className={css.wxKey}>Wind</span><span className={css.wxVal}>{metar.wind}</span></>
                  )}
                  {metar.vis && (
                    <><span className={css.wxKey}>Vis</span><span className={css.wxVal}>{metar.vis === '9999' ? '10+ km' : `${metar.vis}m`}</span></>
                  )}
                  {metar.clouds && (
                    <><span className={css.wxKey}>Cloud</span><span className={css.wxVal}>{metar.clouds}</span></>
                  )}
                  {metar.wx && (
                    <><span className={css.wxKey}>Wx</span><span className={css.wxVal}>{metar.wx}</span></>
                  )}
                  {metar.temp && (
                    <><span className={css.wxKey}>T / Td</span><span className={css.wxVal}>{metar.temp.replace('/', ' / ')}°C</span></>
                  )}
                  {metar.qnh && (
                    <><span className={css.wxKey}>QNH</span><span className={css.wxVal}>{metar.qnh}</span></>
                  )}
                </div>
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
                    <pre className={css.tafRaw}>{wx.taf}</pre>
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
