/**
 * AerodromePopup — modal popup for aerodrome features tapped on the map.
 *
 * Native port of web's metar-taf.com-style redesign (see web's
 * AerodromePopup.tsx doc comment / commit 375e2de): Info / Wx / NOTAMs tabs,
 * graphical wind compass + speed dial (WindGauges.tsx), cloud-layer altitude
 * chart (CloudProfile.tsx), hour-by-hour decoded TAF table (TafTimeline.tsx),
 * plain-English METAR narrative, nearest-station METAR/TAF fallback, and a
 * multi-runway picker for which runway the compass shows. All formatting/
 * tone/fallback logic (@open-vfr/shared/{wxFormat,wxStations,fetchWx,
 * parseTaf,runwayWind}) is shared verbatim with web -- only the rendering
 * primitives (View/Text/Svg instead of div/svg/CSS modules) differ.
 */

import React, { useEffect, useState } from 'react'
import {
  Modal, View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, TextInput,
} from 'react-native'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import {
  fetchWxResolved, decodeMetar, parseMetarWind, parseMetarClouds,
  type WxResolved, type WxStationCandidate, type ParsedWind,
} from '@open-vfr/shared/fetchWx'
import { fetchNotams, fmtNotamDate } from '@open-vfr/shared/fetchNotam'
import { computeRunwayWind, effectiveMagBrg, type RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import { sunriseSunset, fmtSunTime } from '@open-vfr/shared/sunCalc'
import { computeAtcStatus, anyNotamAtcRelated, anyNotamHoursChangeRelated } from '@open-vfr/shared/atcStatus'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { parseTaf, type TafPeriod } from '@open-vfr/shared/parseTaf'
import { loadStations, type StationRecord } from '@open-vfr/shared/wxStations'
import {
  visTone, ceilingTone, windTone, fmtVis, fmtWind, fmtObsAge, metarNarrative, type TileTone,
} from '@open-vfr/shared/wxFormat'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { API_BASE, getTileUrls } from '../config'
import { authHeaders } from '../utils/authClient'
import { WindCompassGauge, WindSpeedGauge, type RunwayHeading } from './WindGauges'
import CloudProfile from './CloudProfile'
import TafTimeline from './TafTimeline'

// Fallback search radius -- same as web's, wide enough to reach a
// towered/AWOS-equipped aerodrome from a small grass strip.
const WX_FALLBACK_MAX_NM = 100

interface Frequency {
  service:  string
  freq_mhz: number
  callsign: string
}

const SERVICE_LABEL: Record<string, string> = {
  TWR: 'TWR', APP: 'APP', ATIS: 'ATIS', ATIS_ARR: 'ATIS ARR',
  ATIS_DEP: 'ATIS DEP', SMC: 'GROUND', AFIS: 'AFIS', FIS: 'FIS',
  ACS: 'ACC', RDO: 'RADIO', INFO: 'INFO', MET: 'MET',
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
  length_m?: number
  surface?: string
  thresholds?: Threshold[]
  lighting?: string[]
  visual_approach_aids?: string[]
  declared_distances?: { tora?: number; toda?: number; asda?: number; lda?: number } | null
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

const LIGHTING_LABEL: Record<string, string> = {
  REIL: 'REIL', REL: 'REL', EDGE: 'Edge', CENTERLINE: 'Centerline',
  TDZ: 'TDZ', TAXI_LEAD_OFF: 'Taxi Lead-off', TAXI_LEAD_ON: 'Taxi Lead-on',
  LAHSO: 'LAHSO', ALS: 'ALS', THRESHOLD: 'Threshold', OTHER: 'Lighting',
}

const VASI_LABEL: Record<string, string> = {
  VASI: 'VASI', PAPI: 'PAPI', TRI_COLOR_VASI: 'Tri-Color VASI',
  PULSATING_VASI: 'Pulsating VASI', AOES: 'AOES', OTHER: 'Visual Aid',
}

const HANDLING_LABEL: Record<string, string> = {
  CARGO: 'Cargo', DE_ICING: 'De-Icing', MAINTENANCE: 'Maintenance',
  SECURITY: 'Security', SHELTER: 'Shelter', OTHER: 'Handling',
}

const PASSENGER_LABEL: Record<string, string> = {
  BANK: 'Bank', POST: 'Post', CUSTOMS: 'Customs', LODGING: 'Lodging',
  MEDICAL: 'Medical', RESTAURANT: 'Restaurant', SANITATION: 'Sanitation',
  TRANSPORTATION: 'Transport', LAUNDRY: 'Laundry', CAMPING: 'Camping', OTHER: 'Facility',
}

const DAY_LABEL: Record<string, string> = {
  MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun',
}

const TAF_PERIOD_LABEL: Record<string, string> = {
  BASE: 'FCST', FM: 'FROM', BECMG: 'BECMG', TEMPO: 'TEMPO', PROB30: 'PROB30', PROB40: 'PROB40',
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

/** Same severity-tier colours as GaugesBar's in-flight crosswind gauge (theme.statusOk/Warn/Danger). */
function xwindColor(sev: RunwayWindEnd['crosswindSeverity']): string {
  if (sev === 'strong') return theme.statusDanger
  if (sev === 'moderate') return theme.statusWarn
  if (sev === 'calm') return theme.statusOk
  return theme.textFaint
}

function fmtDeclaredDistances(dd: Runway['declared_distances']): string {
  if (!dd) return ''
  const parts: string[] = []
  if (dd.tora != null) parts.push(`TORA ${dd.tora}`)
  if (dd.toda != null) parts.push(`TODA ${dd.toda}`)
  if (dd.asda != null) parts.push(`ASDA ${dd.asda}`)
  if (dd.lda  != null) parts.push(`LDA ${dd.lda}`)
  return parts.length > 0 ? `${parts.join(' · ')} m` : ''
}

function fmtTafTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`
}

function fmtTafClouds(clouds: { cover: string; baseFt: number }[]): string {
  if (clouds.length === 0) return 'CAVOK/NSC'
  return clouds.map((c) => `${c.cover}${String(Math.round(c.baseFt / 100)).padStart(3, '0')}`).join(' ')
}

const TONE_COLOR: Record<TileTone, string> = {
  ok: theme.accentGreen, warn: theme.statusWarn, danger: theme.statusDanger, info: theme.textSecondary,
}

const FR_COLOR: Record<string, string> = {
  VFR: '#22c55e', MVFR: '#3b82f6', IFR: '#ef4444', LIFR: '#a855f7',
}

export interface AerodromeFeatureProps {
  icao:         string
  name:         string
  type?:        string
  elevation_ft?: number
  frequencies?: Frequency[]
  fuel?:        string[]
  ppr?:         boolean
  ppr_remarks?: string[]
  runways?:     Runway[]
  /** Derived at data-prep time: true if any frequency has service === 'TWR'. */
  towered?:     boolean
  hours_of_operation?:   HoursEntry[]
  handling_facilities?:  string[]
  passenger_facilities?: string[]
  /** WGS84 coordinates, needed for the sunrise/sunset-based ATC status calc
   *  and the METAR/TAF nearest-station fallback distance search. */
  lng?: number
  lat?: number
}

interface Props {
  feature: AerodromeFeatureProps | null
  onClose: () => void
  /**
   * Reports the current wind-derived per-end favored/severity state so
   * AviationMap's 'runway-threshold-label' layer can highlight the same
   * favored runway end shown here (see MapScreen's runwayWindHighlight
   * state) — not just inside this modal. Called with an empty array to
   * clear whenever there's no usable wind, and on every icao change (this
   * modal is reused across selections, not remounted, so the clear can't
   * rely on unmount alone — see the effect below).
   */
  onRunwayWind?: (icao: string, ends: RunwayWindEnd[]) => void
}

export function AerodromePopup({ feature, onClose, onRunwayWind }: Props) {
  const scaledTheme = useScaledTheme()
  const styles = useThemedStyles(makeStyles)
  const runwayStyles = useThemedStyles(makeRunwayStyles)
  const daStyles = useThemedStyles(makeDaStyles)
  const wxStyles = useThemedStyles(makeWxStyles)
  // Hooks must be declared before any conditional return (Rules of Hooks)
  const [activeTab, setActiveTab] = useState<'info' | 'wx' | 'notam'>('info')
  const [selectedRunwayDesig, setSelectedRunwayDesig] = useState<string | null>(null)
  const [oatStr, setOatStr] = useState('')
  const [qnhStr, setQnhStr] = useState('')

  const [wx,          setWx]          = useState<WxResolved | null>(null)
  const [wxLoading,   setWxLoading]   = useState(true)
  const [wxSourceName, setWxSourceName] = useState<string | null>(null)
  const [notams,      setNotams]      = useState<NotamItem[]>([])
  const [notamLoading,setNotamLoading]= useState(true)
  const [tafExpanded, setTafExpanded] = useState(false)
  const [expandedNotams, setExpandedNotams] = useState<Set<string>>(new Set())

  useEffect(() => {
    setSelectedRunwayDesig(null)
    setActiveTab('info')
  }, [feature?.icao])

  useEffect(() => {
    if (!feature) return
    const ac = new AbortController()
    setWx(null); setWxLoading(true); setWxSourceName(null)
    setNotams([]); setNotamLoading(true)
    setTafExpanded(false); setExpandedNotams(new Set())

    const lat = feature.lat, lng = feature.lng
    authHeaders().then((headers) => {
      const aerodromesUrl = getTileUrls().aerodromes
      const wxPromise = lat != null && lng != null
        ? loadStations(aerodromesUrl)
            .catch(() => [] as StationRecord[])
            .then((stations) => {
              const candidates: WxStationCandidate[] = stations
                .filter((s) => s.icao !== feature.icao)
                .map((s) => ({ icao: s.icao, distNm: distanceNm({ lat, lng }, { lat: s.lat, lng: s.lng }) }))
                .filter((c) => c.distNm <= WX_FALLBACK_MAX_NM)
                .sort((a, b) => a.distNm - b.distNm)
              const nameByIcao = new Map(stations.map((s) => [s.icao, s.name]))
              return fetchWxResolved(feature.icao, lat, lng, candidates, API_BASE, ac.signal, headers)
                .then((data) => {
                  setWx(data)
                  setWxSourceName(data.sourceIcao !== feature.icao ? (nameByIcao.get(data.sourceIcao) ?? null) : null)
                })
            })
        // No coordinates on this feature -- can't do a nearest-station
        // search or model-wind fallback, just fetch the aerodrome's own report.
        : fetchWxResolved(feature.icao, 0, 0, [], API_BASE, ac.signal, headers)
            .then((data) => { setWx(data) })

      wxPromise
        .catch((err) => { if ((err as Error).name !== 'AbortError') { /* leave wx null -- "no data" state */ } })
        .finally(() => setWxLoading(false))

      fetchNotams(feature.icao, API_BASE, ac.signal, headers)
        .then((d) => { setNotams(d.notams); setNotamLoading(false) })
        .catch(() => setNotamLoading(false))
    })

    return () => ac.abort()
  }, [feature?.icao, feature?.lat, feature?.lng])

  const metar = wx?.metar ? decodeMetar(wx.metar) : null
  const surfaceWind = metar ? parseMetarWind(metar.wind) : null
  const modelWind: ParsedWind | null = wx?.modelWind
    ? { dirDeg: wx.modelWind.dirDeg, speedKt: wx.modelWind.speedKts, gustKt: null, variable: false, calm: wx.modelWind.speedKts === 0 }
    : null
  const effectiveWind = modelWind ?? surfaceWind
  const windIsModelled = !!modelWind
  const tafPeriods: TafPeriod[] | null = wx?.taf ? parseTaf(wx.taf) : null
  const usingFallbackWx = !!wx && feature && wx.sourceIcao !== feature.icao

  const runways = feature?.runways ?? []
  const allRunwayWindEnds = runways.flatMap((rwy) => computeRunwayWind(rwy.thresholds ?? [], effectiveWind))

  const longestRunway = [...runways].sort((a, b) => (b.length_m ?? 0) - (a.length_m ?? 0))[0]
  const compassRunway = selectedRunwayDesig != null
    ? runways.find((r) => r.designator === selectedRunwayDesig) ?? longestRunway
    : longestRunway
  const compassRunwayWindEnds = compassRunway ? computeRunwayWind(compassRunway.thresholds ?? [], effectiveWind) : []
  const compassFavoredEnd = compassRunwayWindEnds.find((e) => e.favored) ?? null

  const primaryRunwayHeading: RunwayHeading | null = (() => {
    if (!compassRunway?.thresholds || compassRunway.thresholds.length === 0) return null
    const [t0, t1] = compassRunway.thresholds
    if (!t0) return null
    const brg = effectiveMagBrg(t0.mag_brg, t0.true_brg)
    if (brg == null) return null
    return { designators: [t0.designator, t1?.designator ?? '—'], headingDeg: brg }
  })()

  useEffect(() => {
    if (!onRunwayWind || !feature) return
    const withWind = allRunwayWindEnds.filter((e) => e.headwindKt != null)
    onRunwayWind(feature.icao, withWind)
    return () => onRunwayWind(feature.icao, [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature?.icao, JSON.stringify(allRunwayWindEnds)])

  if (!feature) return null

  const freqs   = feature.frequencies ?? []
  const fuel    = feature.fuel ?? []
  const hours     = feature.hours_of_operation ?? []
  const handling  = feature.handling_facilities ?? []
  const passenger = feature.passenger_facilities ?? []

  const sunTimes = feature.lat != null && feature.lng != null
    ? sunriseSunset(feature.lat, feature.lng)
    : { rise: null, set: null }
  const atc = feature.towered ? computeAtcStatus(hours, sunTimes) : null
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
  const notamAtcHint = feature.towered && anyNotamAtcRelated(activeNotamTexts)
  const notamHoursHint = feature.towered && anyNotamHoursChangeRelated(activeNotamTexts)
  const atcColor = atc?.status === 'open' ? theme.statusOk : atc?.status === 'closed' ? theme.statusDanger : theme.textFaint

  // ── Density altitude ──────────────────────────────────────────────────────
  const elevFt = feature.elevation_ft ?? 0
  const oat = parseFloat(oatStr)
  const qnh = parseFloat(qnhStr)
  const pressAltFt = !isNaN(qnh) && qnh > 0 ? elevFt + 30 * (1013.25 - qnh) : null
  const isaTempC = pressAltFt != null ? 15 - 1.98 * (pressAltFt / 1000) : null
  const densityAltFt = pressAltFt != null && !isNaN(oat) && isaTempC != null
    ? Math.round(pressAltFt + 120 * (oat - isaTempC))
    : null
  function daColor(da: number): string {
    const delta = da - elevFt
    if (delta >= 1000) return theme.statusDanger
    if (delta >= 500) return theme.statusWarn
    return theme.accentGreen
  }

  function toggleNotam(id: string) {
    setExpandedNotams((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
      <View style={styles.sheet}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.icao}>{feature.icao}</Text>
            <Text style={styles.name}>{feature.name}</Text>
            {atc && (
              <View style={[styles.atcBadge, { borderColor: atcColor }]}>
                <Text style={[styles.atcBadgeTxt, { color: atcColor }]}>
                  ATC {atc.status === 'open' ? 'Open' : atc.status === 'closed' ? 'Closed' : '?'}
                </Text>
              </View>
            )}
            {notamAtcHint && (
              <Text style={styles.notamHint}>⚠ Active NOTAM may affect ATC/tower — see NOTAMs</Text>
            )}
            {notamHoursHint && (
              <Text style={styles.notamHint}>⏰ Active NOTAM may have changed opening hours — see NOTAMs</Text>
            )}
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeTxt}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Tab bar */}
        <View style={styles.tabBar}>
          <TabBtn label="Info" active={activeTab === 'info'} onPress={() => setActiveTab('info')} />
          <TabBtn
            label="Wx"
            active={activeTab === 'wx'}
            onPress={() => setActiveTab('wx')}
            dotColor={metar?.flightRule ? FR_COLOR[metar.flightRule] : undefined}
          />
          <TabBtn
            label="NOTAMs"
            active={activeTab === 'notam'}
            onPress={() => setActiveTab('notam')}
            count={!notamLoading && notams.length > 0 ? notams.length : undefined}
          />
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          {/* ── Info tab ─────────────────────────────────────────────── */}
          {activeTab === 'info' && (
            <>
              {feature.elevation_ft !== undefined && (
                <Row label="Elevation" value={`${feature.elevation_ft} ft AMSL`} />
              )}
              {feature.type && <Row label="Type" value={feature.type} />}
              {feature.ppr && (
                <View style={styles.badge}>
                  <Text style={styles.badgeTxt}>PPR required</Text>
                </View>
              )}
              {(feature.ppr_remarks ?? []).map((r, i) => (
                <Text key={i} style={styles.remark}>{r}</Text>
              ))}

              {/* Sunrise / Sunset */}
              <Section title="Sun (UTC)">
                <View style={runwayStyles.desigRow}>
                  <Text style={styles.value}>Sunrise {fmtSunTime(sunTimes.rise)}   Sunset {fmtSunTime(sunTimes.set)}</Text>
                </View>
              </Section>

              {freqs.length > 0 && (
                <Section title="Frequencies">
                  {freqs.map((f, i) => (
                    <Row
                      key={i}
                      label={`${SERVICE_LABEL[f.service] ?? f.service}${f.callsign ? ` — ${f.callsign}` : ''}`}
                      value={f.freq_mhz.toFixed(3)}
                    />
                  ))}
                </Section>
              )}

              {fuel.length > 0 && (
                <Section title="Fuel">
                  <Text style={styles.value}>{fuel.join(', ')}</Text>
                </Section>
              )}

              {runways.length > 0 && (
                <Section title="Runways">
                  {runways.map((r, i) => {
                    const windEnds = r.thresholds ? computeRunwayWind(r.thresholds, effectiveWind) : []
                    const hasWind = windEnds.some((e) => e.headwindKt != null)
                    return (
                      <View key={i} style={{ marginBottom: scaledTheme.space1 }}>
                        {windEnds.length > 0 ? (
                          <View style={runwayStyles.desigRow}>
                            {windEnds.map((e, j) => (
                              <React.Fragment key={e.designator}>
                                {j > 0 && <Text style={runwayStyles.slash}>/</Text>}
                                <View style={[
                                  runwayStyles.desigPill,
                                  { borderColor: xwindColor(e.crosswindSeverity) },
                                  e.favored ? { backgroundColor: theme.accentGreen, borderColor: theme.accentGreen } : null,
                                ]}>
                                  <Text style={[runwayStyles.desigTxt, e.favored ? { color: '#08210f' } : null]}>{e.designator}</Text>
                                </View>
                              </React.Fragment>
                            ))}
                            <Text style={runwayStyles.detail}>
                              {[r.length_m ? `${r.length_m} m` : null, r.surface ?? null].filter(Boolean).join(' · ')}
                            </Text>
                          </View>
                        ) : (
                          <Row
                            label={r.designator}
                            value={[r.length_m ? `${r.length_m} m` : null, r.surface ?? null].filter(Boolean).join(' · ')}
                          />
                        )}
                        {hasWind && (
                          <View style={runwayStyles.windRow}>
                            {windEnds.map((e) => e.headwindKt != null && (
                              <Text key={e.designator} style={[runwayStyles.windTxt, { color: xwindColor(e.crosswindSeverity) }]}>
                                {e.designator}: {e.headwindKt >= 0 ? `${e.headwindKt}kt HW` : `${-e.headwindKt}kt TW`} · {e.crosswindKt}kt XW
                              </Text>
                            ))}
                          </View>
                        )}
                        {((r.visual_approach_aids?.length ?? 0) > 0 || (r.lighting?.length ?? 0) > 0) && (
                          <Text style={styles.muted}>
                            {[...(r.visual_approach_aids ?? []).map(v => VASI_LABEL[v] ?? v),
                              ...(r.lighting ?? []).map(l => LIGHTING_LABEL[l] ?? l)].join(', ')}
                          </Text>
                        )}
                        {fmtDeclaredDistances(r.declared_distances) && (
                          <Text style={styles.muted}>{fmtDeclaredDistances(r.declared_distances)}</Text>
                        )}
                      </View>
                    )
                  })}
                </Section>
              )}

              {hours.length > 0 && (
                <Section title="Hours of Operation">
                  {hours.map((h, i) => (
                    <Row key={i} label={fmtHoursEntry(h)} value={h.remarks ?? ''} />
                  ))}
                </Section>
              )}

              {(handling.length > 0 || passenger.length > 0) && (
                <Section title="Facilities">
                  <Text style={styles.value}>
                    {[...handling.map(h => HANDLING_LABEL[h] ?? h),
                      ...passenger.map(p2 => PASSENGER_LABEL[p2] ?? p2)].join(', ')}
                  </Text>
                </Section>
              )}
            </>
          )}

          {/* ── Wx tab ───────────────────────────────────────────────── */}
          {activeTab === 'wx' && (
            <>
              {/* Density altitude */}
              <Section title="Density Altitude">
                <View style={daStyles.row}>
                  <Text style={daStyles.label}>OAT</Text>
                  <TextInput
                    style={daStyles.input}
                    value={oatStr}
                    onChangeText={setOatStr}
                    placeholder="°C"
                    placeholderTextColor={theme.textFaint}
                    keyboardType="numbers-and-punctuation"
                  />
                  <Text style={daStyles.label}>QNH</Text>
                  <TextInput
                    style={daStyles.input}
                    value={qnhStr}
                    onChangeText={setQnhStr}
                    placeholder={metar?.qnh ? metar.qnh.slice(1) : 'hPa'}
                    placeholderTextColor={theme.textFaint}
                    keyboardType="numeric"
                  />
                </View>
                {densityAltFt != null ? (
                  <Text style={[daStyles.result, { color: daColor(densityAltFt) }]}>
                    {densityAltFt.toLocaleString()} ft density alt
                    {pressAltFt != null ? `  ·  PA ${Math.round(pressAltFt).toLocaleString()} ft` : ''}
                  </Text>
                ) : pressAltFt != null ? (
                  <Text style={daStyles.hint}>PA {Math.round(pressAltFt).toLocaleString()} ft — enter OAT for density alt</Text>
                ) : (
                  <Text style={daStyles.hint}>Enter QNH and OAT</Text>
                )}
              </Section>

              {/* Weather */}
              <Section title="Weather">
                {wxLoading && <ActivityIndicator size="small" color={theme.accentBlue} />}
                {!wxLoading && !wx?.metar && !wx?.taf && !wx?.modelWind && (
                  <Text style={styles.muted}>No weather data at {feature.icao} or any nearby station</Text>
                )}

                {usingFallbackWx && wx && (
                  <Text style={wxStyles.fallback}>
                    No local report for {feature.icao} — showing {wx.sourceIcao}{wxSourceName ? ` (${wxSourceName})` : ''}
                    {wx.distNm != null ? `, ${Math.round(wx.distNm)} NM away` : ''}
                  </Text>
                )}

                {!wxLoading && !wx?.metar && !wx?.taf && wx?.modelWind && (
                  <>
                    <Text style={wxStyles.fallback}>
                      No METAR/TAF at {feature.icao} or any nearby station — showing modelled wind (Open-Meteo forecast, not an observation)
                    </Text>
                    <View style={wxStyles.gaugeRow}>
                      <WindCompassGauge wind={effectiveWind} runway={primaryRunwayHeading} tone={windTone(effectiveWind)} />
                      <WindSpeedGauge wind={effectiveWind} tone={windTone(effectiveWind)} />
                    </View>
                  </>
                )}

                {metar && (
                  <>
                    {metar.flightRule && (
                      <View style={[styles.frBadge, { borderColor: FR_COLOR[metar.flightRule] }]}>
                        <Text style={[styles.frTxt, { color: FR_COLOR[metar.flightRule] }]}>
                          {metar.flightRule}{metar.time ? `  ${metar.time}` : ''}{fmtObsAge(metar.obsMs) ? `  ·  ${fmtObsAge(metar.obsMs)}` : ''}
                        </Text>
                      </View>
                    )}

                    {runways.length > 1 && (
                      <View style={wxStyles.rwyPicker}>
                        {[...runways].sort((a, b) => (b.length_m ?? 0) - (a.length_m ?? 0)).map((rwy) => {
                          const isSelected = compassRunway?.designator === rwy.designator
                          return (
                            <TouchableOpacity
                              key={rwy.designator}
                              style={[wxStyles.rwyPickerBtn, isSelected ? wxStyles.rwyPickerBtnActive : null]}
                              onPress={() => setSelectedRunwayDesig(rwy.designator)}
                            >
                              <Text style={[wxStyles.rwyPickerTxt, isSelected ? wxStyles.rwyPickerTxtActive : null]}>{rwy.designator}</Text>
                            </TouchableOpacity>
                          )
                        })}
                      </View>
                    )}

                    <View style={wxStyles.gaugeRow}>
                      <WindCompassGauge
                        wind={effectiveWind}
                        runway={primaryRunwayHeading}
                        tone={windTone(effectiveWind)}
                        favoredEndDesignator={compassFavoredEnd?.designator ?? null}
                      />
                      <WindSpeedGauge wind={effectiveWind} tone={windTone(effectiveWind)} />
                    </View>
                    {windIsModelled && (
                      <Text style={wxStyles.modelledNote}>
                        Wind is modelled (Open-Meteo), not from {wx?.sourceIcao}'s own observation — that station is too far away for its wind to be locally representative here.
                      </Text>
                    )}

                    <View style={wxStyles.tileGrid}>
                      <WxTile label={`Wind${windIsModelled ? ' (modelled)' : ''}`} value={fmtWind(effectiveWind)} color={TONE_COLOR[windTone(effectiveWind)]} />
                      <WxTile label="Visibility" value={fmtVis(metar.visM)} color={TONE_COLOR[visTone(metar.visM)]} />
                      <WxTile label="Ceiling" value={metar.ceilingFt != null ? `${metar.ceilingFt.toLocaleString()} ft` : metar.clouds === 'CAVOK' ? 'CAVOK' : 'No ceiling'} color={TONE_COLOR[ceilingTone(metar.ceilingFt)]} />
                      <WxTile label="QNH" value={metar.qnh ? metar.qnh.slice(1) : '—'} color={theme.textSecondary} />
                      {metar.temp && <WxTile label="T / Td" value={`${metar.temp.replace('/', ' / ')}°C`} color={theme.textSecondary} />}
                      {metar.wx && <WxTile label="Wx" value={metar.wx} color={theme.statusWarn} />}
                    </View>

                    {metar.clouds && metar.clouds !== 'CAVOK' && (
                      <CloudProfile clouds={parseMetarClouds(metar.clouds)} />
                    )}

                    <Text style={wxStyles.narrative}>{metarNarrative(metar).join(' ')}</Text>
                  </>
                )}

                {wx?.metar && <Text style={styles.rawMetar}>{wx.metar}</Text>}

                {wx?.taf && (
                  <View style={wxStyles.tafBlock}>
                    <TouchableOpacity onPress={() => setTafExpanded(e => !e)} style={styles.tafToggle}>
                      <Text style={styles.tafToggleTxt}>{tafExpanded ? '▴ Hide TAF' : '▾ Show TAF'}</Text>
                    </TouchableOpacity>
                    {tafExpanded && (
                      <>
                        {tafPeriods && tafPeriods.length > 0 && (
                          <TafTimeline periods={tafPeriods} lat={feature.lat ?? 0} lng={feature.lng ?? 0} />
                        )}
                        {tafPeriods && tafPeriods.length > 0 && (
                          <View style={wxStyles.tafPeriods}>
                            <Text style={wxStyles.tafPeriodsLabel}>Change groups</Text>
                            {tafPeriods.map((period, i) => (
                              <View key={i} style={wxStyles.tafPeriod}>
                                <View style={wxStyles.tafPeriodHead}>
                                  <Text style={wxStyles.tafPeriodKind}>{TAF_PERIOD_LABEL[period.kind] ?? period.kind}</Text>
                                  <Text style={wxStyles.tafPeriodTime}>{fmtTafTime(period.fromMs)} – {fmtTafTime(period.toMs)}</Text>
                                </View>
                                <Text style={wxStyles.tafPeriodBody}>
                                  {period.wind ? `${fmtWind(period.wind)}  ` : ''}{fmtTafClouds(period.clouds)}
                                </Text>
                              </View>
                            ))}
                          </View>
                        )}
                        <Text style={styles.tafText}>{wx.taf}</Text>
                      </>
                    )}
                  </View>
                )}
              </Section>
            </>
          )}

          {/* ── NOTAMs tab ───────────────────────────────────────────── */}
          {activeTab === 'notam' && (
            <Section title={`NOTAMs${notams.length > 0 ? ` (${notams.length})` : ''}`}>
              {notamLoading && <ActivityIndicator size="small" color={theme.accentBlue} />}
              {!notamLoading && notams.length === 0 && (
                <Text style={styles.muted}>No NOTAMs</Text>
              )}
              {notams.map((n) => {
                const expanded = expandedNotams.has(n.id)
                return (
                  <TouchableOpacity key={n.id} style={styles.notamRow} onPress={() => toggleNotam(n.id)}>
                    <Text style={styles.notamId}>{n.id} {expanded ? '▴' : '▾'}</Text>
                    {n.effective && (
                      <Text style={styles.notamDate}>{fmtNotamDate(n.effective)} → {fmtNotamDate(n.expires)}</Text>
                    )}
                    {expanded && <Text style={styles.notamText}>{n.text}</Text>}
                  </TouchableOpacity>
                )
              })}
            </Section>
          )}
        </ScrollView>
      </View>
    </Modal>
  )
}

function TabBtn({ label, active, onPress, dotColor, count }: {
  label: string; active: boolean; onPress: () => void; dotColor?: string; count?: number
}) {
  const tabStyles = useThemedStyles(makeTabStyles)
  return (
    <TouchableOpacity style={[tabStyles.tab, active ? tabStyles.tabActive : null]} onPress={onPress}>
      <View style={tabStyles.tabInner}>
        {dotColor && <View style={[tabStyles.dot, { backgroundColor: dotColor }]} />}
        <Text style={[tabStyles.tabTxt, active ? tabStyles.tabTxtActive : null]}>{label}</Text>
        {count != null && (
          <View style={tabStyles.count}>
            <Text style={tabStyles.countTxt}>{count}</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  )
}

function WxTile({ label, value, color }: { label: string; value: string; color: string }) {
  const wxStyles = useThemedStyles(makeWxStyles)
  return (
    <View style={wxStyles.tile}>
      <Text style={wxStyles.tileLabel}>{label}</Text>
      <Text style={[wxStyles.tileValue, { color }]}>{value}</Text>
    </View>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const sectionStyles = useThemedStyles(makeSectionStyles)
  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.title}>{title.toUpperCase()}</Text>
      {children}
    </View>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  const rowStyles = useThemedStyles(makeRowStyles)
  return (
    <View style={rowStyles.row}>
      <Text style={rowStyles.label}>{label}</Text>
      <Text style={rowStyles.value}>{value}</Text>
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: theme.surfacePanel,
    borderTopLeftRadius:  theme.radiusLg,
    borderTopRightRadius: theme.radiusLg,
    borderTopWidth:  1,
    borderColor:     theme.borderDefault,
    maxHeight:       '80%',
  },
  header: {
    flexDirection:   'row',
    alignItems:      'flex-start',
    justifyContent:  'space-between',
    padding:         theme.space4,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  headerLeft: {
    flex: 1,
  },
  icao: {
    color:      theme.textPrimary,
    fontSize:   theme.textXl,
    fontWeight: '800',
    letterSpacing: 1,
  },
  name: {
    color:    theme.textSecondary,
    fontSize: theme.textSm,
    marginTop: 2,
  },
  closeBtn: {
    padding: theme.space2,
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  atcBadge: {
    alignSelf:       'flex-start',
    borderWidth:     1,
    borderRadius:    theme.radiusSm,
    paddingHorizontal: theme.space2,
    paddingVertical:   1,
    marginTop:       4,
  },
  atcBadgeTxt: {
    fontSize:   theme.textXs,
    fontWeight: '700',
  },
  notamHint: {
    color:    theme.statusWarn,
    fontSize: theme.textXs,
    fontWeight: '600',
    marginTop: 3,
    maxWidth: 260,
  },
  closeTxt: {
    color:    theme.textMuted,
    fontSize: theme.textMd,
  },
  body: {
    padding: theme.space4,
    gap:     theme.space2,
  },
  badge: {
    alignSelf:       'flex-start',
    backgroundColor: 'rgba(220,100,0,0.15)',
    borderRadius:    theme.radiusSm,
    paddingHorizontal: theme.space2,
    paddingVertical:   2,
    borderWidth:     1,
    borderColor:     'rgba(220,100,0,0.4)',
  },
  badgeTxt: {
    color:    '#dc6400',
    fontSize: theme.textXs,
    fontWeight: '600',
  },
  remark: {
    color:    theme.textMuted,
    fontSize: theme.textXs,
  },
  value: {
    color:    theme.textPrimary,
    fontSize: theme.textSm,
  },
  muted: {
    color:    theme.textSecondary,
    fontSize: theme.textSm,
    fontStyle: 'italic',
  },
  frBadge: {
    alignSelf:       'flex-start',
    borderWidth:     1.5,
    borderRadius:    theme.radiusSm,
    paddingHorizontal: theme.space3,
    paddingVertical:   4,
    marginBottom:    theme.space2,
  },
  frTxt: {
    fontSize:   theme.textMd,
    fontWeight: '800',
    letterSpacing: 1,
  },
  rawMetar: {
    color:      theme.textSecondary,
    fontSize:   12,
    marginTop:  theme.space2,
    fontFamily: 'monospace',
    lineHeight: 17,
  },
  tafToggle: {
    marginTop: theme.space2,
  },
  tafToggleTxt: {
    color:    theme.accentBlue,
    fontSize: theme.textMd,
    fontWeight: '700',
  },
  tafText: {
    color:      theme.textSecondary,
    fontSize:   12,
    marginTop:  theme.space1,
    fontFamily: 'monospace',
    lineHeight: 17,
  },
  notamRow: {
    gap:          3,
    paddingVertical: theme.space2,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  notamId: {
    color:      theme.accentBlue,
    fontSize:   theme.textMd,
    fontWeight: '700',
  },
  notamDate: {
    color:    theme.textSecondary,
    fontSize: theme.textXs,
  },
  notamText: {
    color:    theme.textSecondary,
    fontSize: theme.textSm,
    lineHeight: 17,
    marginTop: 2,
  },
} as const
}

function makeTabStyles(theme: ScaledTheme) {
 return {
  tab: {
    flex: 1,
    paddingVertical: theme.space2,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: theme.accentBlue,
  },
  tabInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tabTxt: {
    color:    theme.textSecondary,
    fontSize: theme.textMd,
    fontWeight: '700',
  },
  tabTxtActive: {
    color: theme.textPrimary,
  },
  count: {
    backgroundColor: theme.surfaceHover,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 6,
    minWidth: 18,
    alignItems: 'center',
  },
  countTxt: {
    color: theme.textPrimary,
    fontSize: 11,
    fontWeight: '800',
  },
} as const
}

function makeWxStyles(theme: ScaledTheme) {
 return {
  fallback: {
    color:    theme.accentBlue,
    fontSize: theme.textSm,
    fontWeight: '600',
    marginBottom: theme.space2,
  },
  gaugeRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginVertical: theme.space2,
  },
  modelledNote: {
    color:    theme.textSecondary,
    fontSize: theme.textXs,
    fontStyle: 'italic',
    marginBottom: theme.space2,
  },
  rwyPicker: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: theme.space2,
  },
  rwyPickerBtn: {
    borderWidth: 1.5,
    borderColor: theme.borderStrong,
    borderRadius: theme.radiusSm,
    paddingHorizontal: theme.space3,
    paddingVertical: 5,
  },
  rwyPickerBtnActive: {
    backgroundColor: theme.accentBlue,
    borderColor: theme.accentBlue,
  },
  rwyPickerTxt: {
    color: theme.textSecondary,
    fontSize: theme.textMd,
    fontWeight: '700',
  },
  rwyPickerTxtActive: {
    color: '#fff',
  },
  tileGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: theme.space2,
  },
  tile: {
    minWidth: 92,
    backgroundColor: theme.surfaceHover,
    borderRadius: theme.radiusSm,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  tileLabel: {
    color: theme.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  tileValue: {
    fontSize: theme.textLg,
    fontWeight: '800',
    marginTop: 3,
  },
  narrative: {
    color: theme.textSecondary,
    fontSize: theme.textSm,
    lineHeight: 19,
    marginTop: theme.space2,
  },
  tafBlock: {
    marginTop: theme.space2,
  },
  tafPeriods: {
    marginTop: theme.space2,
    gap: 6,
  },
  tafPeriodsLabel: {
    color: theme.textSecondary,
    fontSize: theme.textXs,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  tafPeriod: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  tafPeriodHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  tafPeriodKind: {
    color: theme.accentBlue,
    fontSize: theme.textSm,
    fontWeight: '700',
  },
  tafPeriodTime: {
    color: theme.textSecondary,
    fontSize: theme.textXs,
  },
  tafPeriodBody: {
    color: theme.textPrimary,
    fontSize: theme.textSm,
    marginTop: 3,
  },
} as const
}

function makeDaStyles(theme: ScaledTheme) {
 return {
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    color: theme.textSecondary,
    fontSize: theme.textSm,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1.5,
    borderColor: theme.borderStrong,
    borderRadius: theme.radiusSm,
    paddingHorizontal: theme.space2,
    paddingVertical: 6,
    color: theme.textPrimary,
    fontSize: theme.textMd,
    minWidth: 66,
  },
  result: {
    fontSize: theme.textMd,
    fontWeight: '800',
    marginTop: theme.space2,
  },
  hint: {
    color: theme.textSecondary,
    fontSize: theme.textSm,
    marginTop: theme.space2,
  },
} as const
}

function makeSectionStyles(theme: ScaledTheme) {
 return {
  container: {
    marginTop: theme.space2,
    gap:       2,
  },
  title: {
    color:         theme.textSecondary,
    fontSize:      theme.textSm,
    fontWeight:    '700',
    letterSpacing: 0.8,
    marginBottom:  theme.space2,
  },
} as const
}

function makeRunwayStyles(theme: ScaledTheme) {
 return {
  desigRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
    flexWrap:      'wrap',
  },
  desigPill: {
    borderWidth:   1,
    borderRadius:  4,
    paddingHorizontal: 5,
    paddingVertical:   1,
  },
  desigTxt: {
    color:      theme.textPrimary,
    fontSize:   theme.textSm,
    fontWeight: '700',
  },
  slash: {
    color:    theme.textSecondary,
    fontSize: theme.textSm,
  },
  detail: {
    color:    theme.textSecondary,
    fontSize: theme.textSm,
    marginLeft: theme.space2,
  },
  windRow: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           10,
    marginTop:     3,
  },
  windTxt: {
    fontSize: theme.textXs,
    fontWeight: '600',
  },
} as const
}

function makeRowStyles(theme: ScaledTheme) {
 return {
  row: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    gap:            theme.space2,
  },
  label: {
    color:    theme.textSecondary,
    fontSize: theme.textSm,
    flex:     1,
  },
  value: {
    color:      theme.textPrimary,
    fontSize:   theme.textSm,
    fontWeight: '600',
    textAlign:  'right',
    flexShrink: 1,
  },
} as const
}
