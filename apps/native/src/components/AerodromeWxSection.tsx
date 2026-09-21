/**
 * AerodromeWxSection — the Wx-tab content extracted verbatim from
 * AerodromePopup.tsx (density-altitude calc, METAR tile grid, cloud
 * profile, TAF timeline/raw text, runway picker + wind gauges) so it can
 * be reused wherever a single aerodrome's weather needs the exact same
 * display without a full aerodrome tap — e.g. VicinityBriefSheet.tsx's
 * Wx tab, driven by its own aerodrome picker instead of a map selection.
 *
 * Fully self-contained: owns its own OAT/QNH inputs, runway-picker
 * selection, and TAF-expanded toggle. Callers just supply the aerodrome's
 * static feature data (name/elevation/runways) plus the already-fetched
 * wx/loading/source-name state (see useAerodromeBriefing.ts) -- this
 * component does not fetch anything itself, so callers can share one
 * fetch across Wx + NOTAM tabs the same way AerodromePopup does.
 */

import React, { useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import type { WxResolved } from '@open-vfr/shared/fetchWx'
import { visTone, ceilingTone, windTone, fmtVis, fmtWind, fmtObsAge, metarNarrative } from '@open-vfr/shared/wxFormat'
import { parseMetarClouds } from '@open-vfr/shared/fetchWx'
import { deriveWxDisplay } from '../utils/deriveWxDisplay'
import { Section, TONE_COLOR, FR_COLOR } from './AerodromeBriefShared'
import { WindCompassGauge, WindSpeedGauge } from './WindGauges'
import CloudProfile from './CloudProfile'
import TafTimeline from './TafTimeline'

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

interface RunwayLite {
  designator: string
  length_m?: number
  thresholds?: { designator: string; lat: number; lon: number; true_brg: number | null; mag_brg: number | null }[]
}

interface Props {
  icao:         string
  lat?:         number
  lng?:         number
  elevationFt?: number
  runways:      RunwayLite[]
  wx:           WxResolved | null
  wxLoading:    boolean
  wxSourceName: string | null
}

export default function AerodromeWxSection({ icao, lat, lng, elevationFt, runways, wx, wxLoading, wxSourceName }: Props) {
  const styles = useThemedStyles(makeStyles)
  const daStyles = useThemedStyles(makeDaStyles)
  const wxStyles = useThemedStyles(makeWxStyles)

  const [selectedRunwayDesig, setSelectedRunwayDesig] = useState<string | null>(null)
  const [tafExpanded, setTafExpanded] = useState(false)
  const [oatStr, setOatStr] = useState('')
  const [qnhStr, setQnhStr] = useState('')

  const {
    metar, effectiveWind, windIsModelled, tafPeriods, usingFallbackWx,
    compassRunway, compassFavoredEnd, primaryRunwayHeading,
  } = deriveWxDisplay(wx, runways, icao, selectedRunwayDesig)

  // ── Density altitude ──────────────────────────────────────────────────
  const elevFt = elevationFt ?? 0
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

  return (
    <>
      {/* Weather */}
      <Section title="Weather">
        {wxLoading && <ActivityIndicator size="small" color={theme.accentBlue} />}
        {!wxLoading && !wx?.metar && !wx?.taf && !wx?.modelWind && (
          <Text style={styles.muted}>No weather data at {icao} or any nearby station</Text>
        )}

        {usingFallbackWx && wx && (
          <Text style={wxStyles.fallback}>
            No local report for {icao} — showing {wx.sourceIcao}{wxSourceName ? ` (${wxSourceName})` : ''}
            {wx.distNm != null ? `, ${Math.round(wx.distNm)} NM away` : ''}
          </Text>
        )}

        {!wxLoading && !wx?.metar && !wx?.taf && wx?.modelWind && (
          <>
            <Text style={wxStyles.fallback}>
              No METAR/TAF at {icao} or any nearby station — showing modelled wind (Open-Meteo forecast, not an observation)
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
                  {metar.flightRule}
                  {(metar.time || fmtObsAge(metar.obsMs)) && (
                    <Text style={styles.frUpdated}>
                      {metar.time ? `  ${metar.time}` : ''}{fmtObsAge(metar.obsMs) ? `  ·  ${fmtObsAge(metar.obsMs)}` : ''}
                    </Text>
                  )}
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
                  <TafTimeline periods={tafPeriods} lat={lat ?? 0} lng={lng ?? 0} />
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

      {/* Density altitude — moved below Weather; niche calc, not the reason
          most pilots open this tab, and its two inputs shouldn't push the
          actual METAR/TAF below the fold. */}
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
    </>
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

function makeStyles(theme: ScaledTheme) {
 return {
  muted: {
    color:    theme.textSecondary,
    fontSize: theme.textSm,
    fontStyle: 'italic',
  },
  frBadge: {
    alignSelf:       'flex-start',
    borderWidth:     1,
    borderRadius:    theme.radiusSm,
    paddingHorizontal: theme.space2,
    paddingVertical:   2,
    marginBottom:    theme.space2,
  },
  frTxt: {
    fontSize:   theme.textSm,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  frUpdated: {
    color:      theme.textFaint,
    fontSize:   theme.textXs,
    fontWeight: '500',
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
    fontSize: theme.textXs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  tileValue: {
    fontSize: theme.textMd,
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
    fontSize: theme.textXs,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: theme.radiusSm,
    paddingHorizontal: theme.space2,
    paddingVertical: 4,
    color: theme.textPrimary,
    fontSize: theme.textSm,
    minWidth: 56,
  },
  result: {
    fontSize: theme.textSm,
    fontWeight: '700',
    marginTop: theme.space1,
  },
  hint: {
    color: theme.textSecondary,
    fontSize: theme.textXs,
    marginTop: theme.space1,
  },
} as const
}
