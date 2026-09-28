/**
 * VicinityBriefSheet — single consolidated trigger replacing the three
 * separate top-right buttons FrequencyPanel / RegionalNotamsSheet /
 * WeatherAlongRouteSheet used to be (see MapScreen.tsx wiring). One 40×40
 * icon opens one bottom sheet with a Freq / Wx / NOTAM tab bar, mirroring
 * AerodromePopup's own tab bar minus its Info tab (no single aerodrome has
 * been tapped here).
 *
 * - Freq tab: primarily FrequencyPanel's flat GPS-radius list (no picker)
 *   -- but that hook is GPS-only, no route-buffer/home-airfield fallback
 *   tier at all, so it goes empty with no live GPS fix even with a route
 *   loaded (e.g. planning at a desk, not simulating flight) while Wx/NOTAM
 *   below still work fine via useVicinityAerodromes.ts's route-buffer tier.
 *   Falls back to deriving the same NearbyAerodrome shape from `vicinity`
 *   (already route/GPS/home-prioritized and along-route sorted) whenever
 *   the GPS-only list is empty, instead of leaving the tab looking broken.
 *   See useVicinityAerodromes.ts's own `frequencies` field doc comment.
 * - Wx / NOTAM tabs: share one aerodrome picker (useVicinityAerodromes.ts),
 *   defaulting to the closest aerodrome -- along the route when one is
 *   loaded AND marked Active (routeVisible), otherwise nearest by GPS
 *   radius. Switching tabs
 *   keeps the same picked aerodrome; switching aerodrome refetches via
 *   useAerodromeBriefing.ts (one fetch at a time, for whichever aerodrome
 *   is currently picked — not one per aerodrome in range).
 * - NOTAM tab also lists FIR-wide "Other NOTAMs" with no aerodrome tie
 *   (military notices, navaid outages, etc.), reusing the same
 *   route-proximity filter RegionalNotamsSheet used.
 */

import React, { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, Modal, ScrollView } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import type { RouteWaypoint } from '@open-vfr/shared/types'
import type { GpsPosition } from '../utils/gpsTypes'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import type { NearbyAerodrome } from '../hooks/useNearbyFrequencies'
import { pickPrimary } from '../hooks/useNearbyFrequencies'
import { useVicinityAerodromes } from '../hooks/useVicinityAerodromes'
import { useAerodromeBriefing } from '../hooks/useAerodromeBriefing'
import { FR_COLOR } from './AerodromeBriefShared'
import AerodromeWxSection from './AerodromeWxSection'
import AerodromeNotamSection, { useNotamLists } from './AerodromeNotamSection'
import { decodeMetar } from '@open-vfr/shared/fetchWx'

const SVC_COLOR: Record<string, string> = {
  TWR: '#3b82f6', AFIS: '#3b82f6', APP: '#8b5cf6', DEP: '#8b5cf6',
  GND: '#10b981', SMC: '#10b981', ATIS: '#f59e0b', FIS: '#06b6d4',
  INFO: '#06b6d4', RDO: '#94a3b8', RADIO: '#94a3b8', UNICOM: '#94a3b8',
}
function svcColor(svc: string) { return SVC_COLOR[svc] ?? theme.textMuted }

type Tab = 'freq' | 'wx' | 'notam'

interface Props {
  nearby:         NearbyAerodrome[]
  regionalNotams: NotamItem[]
  waypoints:      RouteWaypoint[]
  position:       GpsPosition | null
  /** RouteContext's own Active/Inactive toggle -- see useVicinityAerodromes.ts. */
  routeVisible:   boolean
  /** Settings-page home airfield ICAO -- last-resort picker fallback. */
  homeIcao?:      string
}

export function VicinityBriefSheet({ nearby, regionalNotams, waypoints, position, routeVisible, homeIcao }: Props) {
  const scaledTheme = useScaledTheme()
  const styles = useThemedStyles(makeStyles)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('freq')

  const vicinity = useVicinityAerodromes({ waypoints, position, routeVisible, homeIcao })
  const [selectedIcao, setSelectedIcao] = useState<string | null>(null)

  useEffect(() => {
    if (vicinity.length === 0) { setSelectedIcao(null); return }
    setSelectedIcao((prev) => (prev && vicinity.some((a) => a.icao === prev)) ? prev : vicinity[0].icao)
  }, [vicinity])

  const selected = vicinity.find((a) => a.icao === selectedIcao) ?? null
  const { wx, wxLoading, wxSourceName, ambientWx, notams, notamLoading } =
    useAerodromeBriefing(selected?.icao ?? null, selected?.lat, selected?.lng)

  // Which wx tab is displayed -- see AerodromeWxSection.tsx's doc comment.
  // Reset whenever the picked aerodrome changes.
  const [wxSource, setWxSource] = useState<'metar' | 'station'>('metar')
  useEffect(() => { setWxSource('metar') }, [selected?.icao])
  // No METAR/TAF anywhere -- default to the Weather station tab instead of
  // an empty METAR panel, without overriding a manual pick already made
  // for this aerodrome.
  useEffect(() => {
    if (wxLoading) return
    if (!wx?.metar && !wx?.taf) setWxSource('station')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wxLoading, selected?.icao])

  // Same lists the NOTAMs tab renders (route/vicinity scope, VFR-only, FIR
  // relevance) so the tab badge counts what the tab actually shows.
  const hasRoute = waypoints.length > 0
  const notamLists = useNotamLists({
    notams, regionalNotams, routeWaypoints: waypoints,
    centre: selected ? { lat: selected.lat, lng: selected.lng } : undefined,
    icao: selected?.icao,
  })

  // Tab-dot colour always reflects the real METAR's flight rule when one
  // exists, regardless of which Wx tab (METAR vs Weather station) happens
  // to be currently selected -- Weather station has no flight-rule concept.
  const metarFlightRule = wx?.metar ? decodeMetar(wx.metar).flightRule : null

  // See this file's own doc comment on the Freq tab's route/home fallback.
  const displayedFreqs: NearbyAerodrome[] = nearby.length > 0
    ? nearby
    : vicinity.map((a) => ({
        icao: a.icao, name: a.name, distNm: a.distNm,
        primaryFreq: pickPrimary(a.frequencies), frequencies: a.frequencies,
      }))

  const badgeCount = tab === 'freq' ? displayedFreqs.length : vicinity.length

  return (
    <>
      <TouchableOpacity style={styles.trigger} onPress={() => setOpen(true)} activeOpacity={0.8}>
        <Ionicons name="newspaper-outline" size={19} color={theme.accentBlue} />
        {badgeCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeTxt}>{badgeCount}</Text>
          </View>
        )}
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Vicinity Briefing</Text>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Tab bar */}
          <View style={styles.tabBar}>
            <TabBtn label="Frequencies" active={tab === 'freq'} onPress={() => setTab('freq')} />
            <TabBtn
              label="Weather" active={tab === 'wx'} onPress={() => setTab('wx')}
              dotColor={metarFlightRule ? FR_COLOR[metarFlightRule] : undefined}
            />
            <TabBtn
              label="NOTAMs" active={tab === 'notam'} onPress={() => setTab('notam')}
              count={notamLists.visibleCount > 0 ? notamLists.visibleCount : undefined}
            />
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
            {/* ── Freq tab — unchanged from FrequencyPanel, no picker ──── */}
            {tab === 'freq' && (
              displayedFreqs.length === 0 ? (
                <Text style={styles.muted}>No aerodromes with published frequencies nearby</Text>
              ) : displayedFreqs.map((ad, i) => (
                <View key={ad.icao || ad.name} style={[styles.adCard, i > 0 && styles.adCardBorder]}>
                  <View style={styles.adHeader}>
                    <Text style={styles.adIcao}>{ad.icao}</Text>
                    <Text style={styles.adName} numberOfLines={1}>{ad.name}</Text>
                    <Text style={styles.adDist}>{ad.distNm.toFixed(1)} NM</Text>
                  </View>
                  {ad.frequencies.length === 0 ? (
                    <Text style={styles.noFreq}>No frequencies on record</Text>
                  ) : (
                    <View style={styles.freqList}>
                      {ad.frequencies.map((f, j) => (
                        <View key={j} style={styles.freqRow}>
                          <View style={[styles.svcBadge, { backgroundColor: svcColor(f.service) + '22', borderColor: svcColor(f.service) + '55' }]}>
                            <Text style={[styles.svcTxt, { color: svcColor(f.service) }]}>{f.service}</Text>
                          </View>
                          <Text style={styles.freqMhz}>{f.mhz.toFixed(3)}</Text>
                          {f.callsign && <Text style={styles.freqCallsign} numberOfLines={1}>{f.callsign}</Text>}
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              ))
            )}

            {/* ── Wx / NOTAM tabs — shared aerodrome picker ────────────── */}
            {(tab === 'wx' || tab === 'notam') && (
              <>
                {vicinity.length === 0 ? (
                  <Text style={styles.muted}>
                    {routeVisible && hasRoute ? 'No aerodromes within range of the active route' : 'No aerodromes nearby'}
                  </Text>
                ) : (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.picker}>
                    {vicinity.map((a) => {
                      const isSelected = a.icao === selectedIcao
                      return (
                        <TouchableOpacity
                          key={a.icao}
                          style={[styles.pickerChip, isSelected && styles.pickerChipActive]}
                          onPress={() => setSelectedIcao(a.icao)}
                        >
                          <Text style={[styles.pickerChipTxt, isSelected && styles.pickerChipTxtActive]}>
                            {a.icao}
                          </Text>
                          <Text style={[styles.pickerChipDist, isSelected && styles.pickerChipTxtActive]}>
                            {a.distNm.toFixed(1)} NM
                          </Text>
                        </TouchableOpacity>
                      )
                    })}
                  </ScrollView>
                )}

                {selected && tab === 'wx' && (
                  <AerodromeWxSection
                    icao={selected.icao}
                    lat={selected.lat}
                    lng={selected.lng}
                    elevationFt={selected.elevationFt}
                    runways={selected.runways}
                    wx={wx}
                    ambientWx={ambientWx}
                    wxSource={wxSource}
                    onSourceChange={setWxSource}
                    wxLoading={wxLoading}
                    wxSourceName={wxSourceName}
                  />
                )}

                {selected && tab === 'notam' && (
                  <AerodromeNotamSection
                    notams={notams}
                    notamLoading={notamLoading}
                    regionalNotams={regionalNotams}
                    routeWaypoints={waypoints}
                    centre={selected ? { lat: selected.lat, lng: selected.lng } : undefined}
                    icao={selected?.icao}
                  />
                )}
              </>
            )}

            <View style={{ height: scaledTheme.space4 }} />
          </ScrollView>
        </View>
      </Modal>
    </>
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

function makeTabStyles(theme: ScaledTheme) {
 return {
  tab: {
    flex: 1, paddingVertical: theme.space2, alignItems: 'center' as const,
    borderBottomWidth: 2, borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: theme.accentBlue },
  tabInner: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tabTxt: { color: theme.textSecondary, fontSize: theme.textSm, fontWeight: '700' as const },
  tabTxtActive: { color: theme.textPrimary },
  count: {
    backgroundColor: theme.surfaceHover, borderRadius: theme.radiusFull,
    paddingHorizontal: 6, minWidth: 18, alignItems: 'center' as const,
  },
  countTxt: { color: theme.textPrimary, fontSize: 11, fontWeight: '800' as const },
 }
}

function makeStyles(theme: ScaledTheme) {
 return {
  trigger: {
    width: 40, height: 40, borderRadius: theme.radiusMd,
    backgroundColor: 'rgba(19,24,36,0.90)', borderWidth: 1, borderColor: theme.borderDefault,
    alignItems: 'center' as const, justifyContent: 'center' as const,
  },
  badge: {
    position: 'absolute' as const, top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: theme.accentBlue, alignItems: 'center' as const, justifyContent: 'center' as const, paddingHorizontal: 3,
  },
  badgeTxt: { color: '#fff', fontSize: 9, fontWeight: '700' as const },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: theme.surfaceSheet, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderColor: theme.borderDefault, maxHeight: '80%' as const,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderDefault, alignSelf: 'center' as const, marginTop: 10, marginBottom: 4 },
  header: {
    flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const,
    paddingHorizontal: theme.space4, paddingVertical: theme.space2,
    borderBottomWidth: 1, borderBottomColor: theme.borderSubtle,
  },
  headerTitle: { color: theme.textPrimary, fontSize: theme.textMd, fontWeight: '700' as const },
  tabBar: { flexDirection: 'row' as const, borderBottomWidth: 1, borderBottomColor: theme.borderSubtle },
  body: { padding: theme.space4, gap: theme.space2 },
  muted: { color: theme.textSecondary, fontSize: theme.textSm, fontStyle: 'italic' as const, paddingVertical: theme.space2 },

  // Freq tab (verbatim from FrequencyPanel)
  adCard: { paddingVertical: theme.space3, gap: theme.space2 },
  adCardBorder: { borderTopWidth: 1, borderTopColor: theme.borderSubtle },
  adHeader: { flexDirection: 'row' as const, alignItems: 'baseline' as const, gap: theme.space2 },
  adIcao: { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '800' as const, letterSpacing: 1, minWidth: 44 },
  adName: { flex: 1, color: theme.textSecondary, fontSize: theme.textXs },
  adDist: { color: theme.accentBlue, fontSize: theme.textXs, fontWeight: '600' as const },
  noFreq: { color: theme.textFaint, fontSize: theme.textXs, fontStyle: 'italic' as const },
  freqList: { gap: 4 },
  freqRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.space2 },
  svcBadge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, minWidth: 40, alignItems: 'center' as const },
  svcTxt: { fontSize: 10, fontWeight: '700' as const },
  freqMhz: { color: theme.textPrimary, fontSize: theme.textXs, fontWeight: '700' as const, minWidth: 56 },
  freqCallsign: { color: theme.textSecondary, fontSize: theme.textXs, flex: 1 },

  // Wx/NOTAM picker
  picker: { flexGrow: 0, marginBottom: theme.space2 },
  pickerChip: {
    borderWidth: 1.5, borderColor: theme.borderStrong, borderRadius: theme.radiusSm,
    paddingHorizontal: theme.space3, paddingVertical: 5, marginRight: 8, alignItems: 'center' as const,
  },
  pickerChipActive: { backgroundColor: theme.accentBlue, borderColor: theme.accentBlue },
  pickerChipTxt: { color: theme.textPrimary, fontSize: theme.textXs, fontWeight: '800' as const, letterSpacing: 0.5 },
  pickerChipDist: { color: theme.textFaint, fontSize: 10 },
  pickerChipTxtActive: { color: '#fff' },
 }
}
