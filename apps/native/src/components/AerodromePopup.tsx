/**
 * AerodromePopup — modal popup for aerodrome features tapped on the map.
 * Shows ICAO, name, elevation, frequencies, fuel, PPR notes.
 */

import React, { useEffect, useState } from 'react'
import {
  Modal, View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native'
import { theme } from '../styles/theme'
import { fetchWx, decodeMetar, parseMetarWind } from '@open-vfr/shared/fetchWx'
import { fetchNotams, fmtNotamDate } from '@open-vfr/shared/fetchNotam'
import { computeRunwayWind, type RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import { sunriseSunset } from '@open-vfr/shared/sunCalc'
import { computeAtcStatus, anyNotamAtcRelated, anyNotamHoursChangeRelated } from '@open-vfr/shared/atcStatus'
import type { WxResult, MetarDecoded } from '@open-vfr/shared/fetchWx'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { API_BASE } from '../config'
import { authHeaders } from '../utils/authClient'

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
  mag_brg?: number
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
  /** WGS84 coordinates, needed for the sunrise/sunset-based ATC status calc. */
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
  // Hooks must be declared before any conditional return (Rules of Hooks)
  const [wx,          setWx]          = useState<WxResult | null>(null)
  const [wxLoading,   setWxLoading]   = useState(true)
  const [notams,      setNotams]      = useState<NotamItem[]>([])
  const [notamLoading,setNotamLoading]= useState(true)
  const [tafExpanded, setTafExpanded] = useState(false)

  useEffect(() => {
    if (!feature) return
    const ac = new AbortController()
    setWx(null); setWxLoading(true)
    setNotams([]); setNotamLoading(true)
    setTafExpanded(false)

    authHeaders().then((headers) => {
      fetchWx(feature.icao, API_BASE, ac.signal, headers)
        .then((d) => { setWx(d); setWxLoading(false) })
        .catch(() => setWxLoading(false))

      fetchNotams(feature.icao, API_BASE, ac.signal, headers)
        .then((d) => { setNotams(d.notams); setNotamLoading(false) })
        .catch(() => setNotamLoading(false))
    })

    return () => ac.abort()
  }, [feature?.icao])

  // Flattened across all runways, computed with null-safe guards so this can
  // run as a hook before the early return below (Rules of Hooks). Reports
  // up to MapScreen -> AviationMap; cleanup clears the PREVIOUS icao's
  // highlight before every re-run (icao change, wind change, or unmount) --
  // this modal persists across selections rather than remounting, so a
  // plain unmount-only cleanup (like web's key-forced-remount AerodromePopup)
  // would leave a stale highlight from the last-viewed aerodrome.
  const wxMetarForWind = wx?.metar ? decodeMetar(wx.metar) : null
  const surfaceWindForWind = wxMetarForWind ? parseMetarWind(wxMetarForWind.wind) : null
  const allRunwayWindEnds = (feature?.runways ?? [])
    .flatMap((rwy) => computeRunwayWind(rwy.thresholds ?? [], surfaceWindForWind))

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
  const runways = feature.runways ?? []
  const hours     = feature.hours_of_operation ?? []
  const handling  = feature.handling_facilities ?? []
  const passenger = feature.passenger_facilities ?? []

  const metar = wx?.metar ? decodeMetar(wx.metar) : null
  const surfaceWind = metar ? parseMetarWind(metar.wind) : null
  const frColor = metar?.flightRule
    ? { VFR: '#22c55e', MVFR: '#3b82f6', IFR: '#ef4444', LIFR: '#a855f7' }[metar.flightRule]
    : undefined

  // ATC status: AIP-schedule-derived only (see @open-vfr/shared/atcStatus).
  // NOTAM text is checked separately and only ever renders as a plain-text
  // hint below, never flips this badge's color/status.
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

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
      <View style={styles.sheet}>
        {/* Header */}
        <View style={styles.header}>
          <View>
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

        <ScrollView contentContainerStyle={styles.body}>
          {/* Elevation */}
          {feature.elevation_ft !== undefined && (
            <Row label="Elevation" value={`${feature.elevation_ft} ft AMSL`} />
          )}

          {/* Type */}
          {feature.type && (
            <Row label="Type" value={feature.type} />
          )}

          {/* PPR */}
          {feature.ppr && (
            <View style={styles.badge}>
              <Text style={styles.badgeTxt}>PPR required</Text>
            </View>
          )}
          {(feature.ppr_remarks ?? []).map((r, i) => (
            <Text key={i} style={styles.remark}>{r}</Text>
          ))}

          {/* Weather */}
          <Section title="Weather">
            {wxLoading && <ActivityIndicator size="small" color={theme.accentBlue} />}
            {!wxLoading && !wx?.metar && <Text style={styles.muted}>No METAR available</Text>}
            {metar && (
              <View style={styles.wxBlock}>
                {metar.flightRule && (
                  <View style={[styles.frBadge, { borderColor: frColor }]}>
                    <Text style={[styles.frTxt, { color: frColor }]}>{metar.flightRule}</Text>
                  </View>
                )}
                {metar.wind   && <Row label="Wind"       value={metar.wind} />}
                {metar.vis    && <Row label="Visibility" value={metar.vis} />}
                {metar.clouds && <Row label="Clouds"     value={metar.clouds} />}
                {metar.temp   && <Row label="Temp / Dew" value={metar.temp} />}
                {metar.qnh    && <Row label="QNH"        value={metar.qnh} />}
                {metar.wx     && <Row label="Present wx" value={metar.wx} />}
                <Text style={styles.rawMetar}>{wx!.metar}</Text>
              </View>
            )}
            {!wxLoading && wx?.taf && (
              <TouchableOpacity onPress={() => setTafExpanded(e => !e)} style={styles.tafToggle}>
                <Text style={styles.tafToggleTxt}>{tafExpanded ? '▾ Hide TAF' : '▸ Show TAF'}</Text>
              </TouchableOpacity>
            )}
            {tafExpanded && wx?.taf && (
              <Text style={styles.tafText}>{wx.taf}</Text>
            )}
          </Section>

          {/* NOTAMs */}
          <Section title={`NOTAMs${notams.length > 0 ? ` (${notams.length})` : ''}`}>
            {notamLoading && <ActivityIndicator size="small" color={theme.accentBlue} />}
            {!notamLoading && notams.length === 0 && (
              <Text style={styles.muted}>No NOTAMs</Text>
            )}
            {notams.slice(0, 5).map((n) => (
              <View key={n.id} style={styles.notamRow}>
                <Text style={styles.notamId}>{n.id}</Text>
                {n.effective && (
                  <Text style={styles.notamDate}>{fmtNotamDate(n.effective)} → {fmtNotamDate(n.expires)}</Text>
                )}
                <Text style={styles.notamText}>{n.text}</Text>
              </View>
            ))}
            {notams.length > 5 && (
              <Text style={styles.muted}>+{notams.length - 5} more</Text>
            )}
          </Section>

          {/* Frequencies */}
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

          {/* Fuel */}
          {fuel.length > 0 && (
            <Section title="Fuel">
              <Text style={styles.value}>{fuel.join(', ')}</Text>
            </Section>
          )}

          {/* Runways */}
          {runways.length > 0 && (
            <Section title="Runways">
              {runways.map((r, i) => {
                const windEnds = r.thresholds ? computeRunwayWind(r.thresholds, surfaceWind) : []
                const hasWind = windEnds.some((e) => e.headwindKt != null)
                return (
                  <View key={i} style={{ marginBottom: theme.space1 }}>
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
                          {[
                            r.length_m ? `${r.length_m} m` : null,
                            r.surface ?? null,
                          ].filter(Boolean).join(' · ')}
                        </Text>
                      </View>
                    ) : (
                      <Row
                        label={r.designator}
                        value={[
                          r.length_m ? `${r.length_m} m` : null,
                          r.surface ?? null,
                          r.mag_brg != null ? `${Math.round(r.mag_brg)}°` : null,
                        ].filter(Boolean).join(' · ')}
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

          {/* Hours of operation */}
          {hours.length > 0 && (
            <Section title="Hours of Operation">
              {hours.map((h, i) => (
                <Row key={i} label={fmtHoursEntry(h)} value={h.remarks ?? ''} />
              ))}
            </Section>
          )}

          {/* Facilities */}
          {(handling.length > 0 || passenger.length > 0) && (
            <Section title="Facilities">
              <Text style={styles.value}>
                {[...handling.map(h => HANDLING_LABEL[h] ?? h),
                  ...passenger.map(p => PASSENGER_LABEL[p] ?? p)].join(', ')}
              </Text>
            </Section>
          )}
        </ScrollView>
      </View>
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.title}>{title.toUpperCase()}</Text>
      {children}
    </View>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={rowStyles.row}>
      <Text style={rowStyles.label}>{label}</Text>
      <Text style={rowStyles.value}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
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
    maxHeight:       '70%',
  },
  header: {
    flexDirection:   'row',
    alignItems:      'flex-start',
    justifyContent:  'space-between',
    padding:         theme.space4,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
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
    fontSize: 9,
    marginTop: 2,
    maxWidth: 220,
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
    color:    theme.textFaint,
    fontSize: theme.textXs,
    fontStyle: 'italic',
  },
  wxBlock: {
    gap: 2,
  },
  frBadge: {
    alignSelf:       'flex-start',
    borderWidth:     1,
    borderRadius:    theme.radiusSm,
    paddingHorizontal: theme.space2,
    paddingVertical:   2,
    marginBottom:    theme.space1,
  },
  frTxt: {
    fontSize:   theme.textXs,
    fontWeight: '800',
    letterSpacing: 1,
  },
  rawMetar: {
    color:      theme.textFaint,
    fontSize:   9,
    marginTop:  theme.space1,
    fontFamily: 'monospace',
  },
  tafToggle: {
    marginTop: theme.space1,
  },
  tafToggleTxt: {
    color:    theme.accentBlue,
    fontSize: theme.textXs,
  },
  tafText: {
    color:      theme.textMuted,
    fontSize:   9,
    marginTop:  theme.space1,
    fontFamily: 'monospace',
    lineHeight: 13,
  },
  notamRow: {
    gap:          2,
    paddingVertical: theme.space1,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  notamId: {
    color:      theme.accentBlue,
    fontSize:   theme.textXs,
    fontWeight: '700',
  },
  notamDate: {
    color:    theme.textFaint,
    fontSize: 9,
  },
  notamText: {
    color:    theme.textMuted,
    fontSize: theme.textXs,
    lineHeight: 14,
  },
})

const sectionStyles = StyleSheet.create({
  container: {
    marginTop: theme.space2,
    gap:       2,
  },
  title: {
    color:         theme.textFaint,
    fontSize:      theme.textXs,
    fontWeight:    '600',
    letterSpacing: 0.8,
    marginBottom:  theme.space1,
  },
})

const runwayStyles = StyleSheet.create({
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
    fontSize:   theme.textXs,
    fontWeight: '700',
  },
  slash: {
    color:    theme.textFaint,
    fontSize: theme.textXs,
  },
  detail: {
    color:    theme.textMuted,
    fontSize: theme.textSm,
    marginLeft: theme.space2,
  },
  windRow: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           10,
    marginTop:     2,
  },
  windTxt: {
    fontSize: 9,
  },
})

const rowStyles = StyleSheet.create({
  row: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    gap:            theme.space2,
  },
  label: {
    color:    theme.textMuted,
    fontSize: theme.textSm,
    flex:     1,
  },
  value: {
    color:      theme.textPrimary,
    fontSize:   theme.textSm,
    fontWeight: '500',
    textAlign:  'right',
    flexShrink: 1,
  },
})
