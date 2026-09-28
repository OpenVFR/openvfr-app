/**
 * AerodromePopup — modal popup for aerodrome features tapped on the map.
 *
 * Native port of web's weather-dashboard-style redesign (see web's
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
  View, Text, ScrollView, TouchableOpacity, Share,
} from 'react-native'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import { computeRunwayWind, type RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import { sunriseSunset, fmtSunTime } from '@open-vfr/shared/sunCalc'
import { computeAtcStatus, anyNotamAtcRelated, anyNotamHoursChangeRelated } from '@open-vfr/shared/atcStatus'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import type { RoutePoint } from '@open-vfr/shared/notamRouteFilter'
import { useAerodromeBriefing } from '../hooks/useAerodromeBriefing'
import { deriveWxDisplay } from '../utils/deriveWxDisplay'
import { Section, FR_COLOR } from './AerodromeBriefShared'
import AerodromeWxSection from './AerodromeWxSection'
import AerodromeNotamSection, { useNotamLists } from './AerodromeNotamSection'
import { buildAerodromeLink } from '@open-vfr/shared/deepLink'
import { NativeSheet } from './NativeSheet'
import { WEB_BASE } from '../config'

/** Link that opens this aerodrome: the web app when WEB_BASE is configured
 *  (openable by anyone), else the app's own scheme. */
function aerodromeShareUrl(icao: string): string {
  return buildAerodromeLink(WEB_BASE || 'openvfr://map', icao)
}

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
  /** FIR-wide NOTAMs (unfiltered) + the planned route -- forwarded straight
   *  to AerodromeNotamSection's own "Other NOTAMs" section (see its doc
   *  comment). Undefined = section omitted, same as before this capability
   *  existed. */
  regionalNotams?: NotamItem[]
  routeWaypoints?: RoutePoint[]
}

export function AerodromePopup({ feature, onClose, onRunwayWind, regionalNotams, routeWaypoints }: Props) {
  const scaledTheme = useScaledTheme()
  const styles = useThemedStyles(makeStyles)
  const runwayStyles = useThemedStyles(makeRunwayStyles)
  // Hooks must be declared before any conditional return (Rules of Hooks)
  const [activeTab, setActiveTab] = useState<'info' | 'wx' | 'notam'>('info')
  // Which wx tab is displayed -- see AerodromeWxSection.tsx's doc comment.
  // Reset alongside activeTab on every feature change (this modal is
  // reused across selections, not remounted).
  const [wxSource, setWxSource] = useState<'metar' | 'station'>('metar')

  const { wx, wxLoading, wxSourceName, ambientWx, notams, notamLoading } =
    useAerodromeBriefing(feature?.icao ?? null, feature?.lat, feature?.lng)
  // Badge counts what the NOTAMs tab lists (after the VFR-only filter).
  const ownNotamCount = useNotamLists({ notams }).notams.length

  useEffect(() => {
    setActiveTab('info')
    setWxSource('metar')
  }, [feature?.icao])

  // No METAR/TAF anywhere -- default to the Weather station tab instead of
  // an empty METAR panel, without overriding a manual pick the user already
  // made for this aerodrome.
  useEffect(() => {
    if (wxLoading) return
    if (!wx?.metar && !wx?.taf) setWxSource('station')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wxLoading, feature?.icao])

  const runways = feature?.runways ?? []
  const { metar, effectiveWind, allRunwayWindEnds } = deriveWxDisplay(wx, runways, feature?.icao, null, wxSource, ambientWx)

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

  return (
    <NativeSheet
      isPresented
      onDismiss={onClose}
      testID="aerodrome-sheet"
      contentContainerStyle={styles.body}
      header={(
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
          {!!feature.icao && (
            <TouchableOpacity
              onPress={() => {
                const url = aerodromeShareUrl(feature.icao)
                // `message` carries the URL too: Android ignores `url`.
                Share.share({ title: `${feature.icao} ${feature.name}`.trim(), message: [`${feature.icao} ${feature.name}`.trim(), url].join('\n'), url }).catch(() => {})
              }}
              style={styles.closeBtn}
              accessibilityLabel="Share link to this aerodrome"
            >
              <Text style={styles.closeTxt}>⇪</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeTxt}>✕</Text>
          </TouchableOpacity>
        </View>
      )}
      fixedTop={(
        <View style={styles.tabBar}>
          <TabBtn label="Info" active={activeTab === 'info'} onPress={() => setActiveTab('info')} />
          <TabBtn
            label="Weather"
            active={activeTab === 'wx'}
            onPress={() => setActiveTab('wx')}
            dotColor={metar?.flightRule ? FR_COLOR[metar.flightRule] : undefined}
          />
          <TabBtn
            label="NOTAMs"
            active={activeTab === 'notam'}
            onPress={() => setActiveTab('notam')}
            count={!notamLoading && ownNotamCount > 0 ? ownNotamCount : undefined}
          />
        </View>
      )}
    >
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
            <AerodromeWxSection
              icao={feature.icao}
              lat={feature.lat}
              lng={feature.lng}
              elevationFt={feature.elevation_ft}
              runways={runways}
              wx={wx}
              ambientWx={ambientWx}
              wxSource={wxSource}
              onSourceChange={setWxSource}
              wxLoading={wxLoading}
              wxSourceName={wxSourceName}
            />
          )}

          {/* ── NOTAMs tab ───────────────────────────────────────────── */}
          {activeTab === 'notam' && (
            <AerodromeNotamSection
              notams={notams}
              notamLoading={notamLoading}
              regionalNotams={regionalNotams}
              routeWaypoints={routeWaypoints}
              centre={feature.lat !== undefined && feature.lng !== undefined ? { lat: feature.lat, lng: feature.lng } : undefined}
              icao={feature.icao}
            />
          )}
    </NativeSheet>
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
    backgroundColor: theme.surfaceSheet,
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
    fontSize:   theme.textLg,
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
    fontSize: theme.textSm,
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
