/**
 * AerodromeWxSection — the Wx-tab content extracted verbatim from
 * AerodromePopup.tsx (density-altitude calc, METAR tile grid, cloud
 * profile, TAF timeline/raw text, runway picker + wind gauges) so it can
 * be reused wherever a single aerodrome's weather needs the exact same
 * display without a full aerodrome tap — e.g. VicinityBriefSheet.tsx's
 * Wx tab, driven by its own aerodrome picker instead of a map selection.
 *
 * Two independent, toggled (never blended) wx sources: METAR (`wx`, own
 * icao auto-falling back to the nearest reporting station -- see
 * useAerodromeBriefing.ts / fetchWxResolved) vs Weather station (`ambientWx`,
 * Open-Meteo's non-aviation ambient reading, always available regardless
 * of whether a real METAR exists). See AGENTS.md's "Wx tab METAR/weather-
 * station toggle" gotcha.
 *
 * Fully self-contained: owns its own OAT/QNH inputs, runway-picker
 * selection, and TAF-expanded toggle. Callers just supply the aerodrome's
 * static feature data (name/elevation/runways) plus the already-fetched
 * wx/ambientWx/loading/source-name state (see useAerodromeBriefing.ts) --
 * this component does not fetch anything itself, so callers can share one
 * fetch across Wx + NOTAM tabs the same way AerodromePopup does.
 */

import React, { useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import type { WxResolved } from '@open-vfr/shared/fetchWx'
import type { AmbientWx } from '@open-vfr/shared/fetchWind'
import { visTone, ceilingTone, windTone, fmtVis, fmtWind, fmtObsAge, metarNarrative } from '@open-vfr/shared/wxFormat'
import { parseMetarClouds } from '@open-vfr/shared/fetchWx'
import { tafChangeSoon } from '@open-vfr/shared/parseTaf'
import { deriveWxDisplay } from '../utils/deriveWxDisplay'
import { computeRunwayWind } from '@open-vfr/shared/runwayWind'
import { Section, FR_BADGE } from './AerodromeBriefShared'
import { WindCompassGauge, WindSpeedGauge } from './WindGauges'
import Svg, { Path } from 'react-native-svg'
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
  /** METAR/TAF -- own icao, auto-falling back to the nearest reporting
   *  station. Possibly empty (no metar/taf anywhere). */
  wx:           WxResolved | null
  /** Open-Meteo ambient reading at this aerodrome's own coordinates --
   *  always available regardless of METAR. Null while loading or on
   *  fetch failure. */
  ambientWx:    AmbientWx | null
  /** Which tab is displayed. Caller owns this (reset when the aerodrome
   *  changes) so it can also drive its own tab-dot flight-rule colour /
   *  map runway highlight off the same selection. */
  wxSource:     'metar' | 'station'
  onSourceChange: (source: 'metar' | 'station') => void
  wxLoading:    boolean
  wxSourceName: string | null
}

export default function AerodromeWxSection({ icao, lat, lng, elevationFt, runways, wx, ambientWx, wxSource, onSourceChange, wxLoading, wxSourceName }: Props) {
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
  } = deriveWxDisplay(wx, runways, icao, selectedRunwayDesig, wxSource, ambientWx)

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

  // Wind-only "suitable" cue -- colours just that specific END's own
  // designator digits (e.g. only "17" within the "17/35" pill), not the
  // whole pill/border, since a runway has two ends and only one of them is
  // ever the one to actually use. NOT a full recommendation (surface,
  // length, lighting, NOTAMs, traffic pattern still matter, a pilot
  // judgement call this picker shouldn't make for them). Scoped to
  // whichever wx source tab is active via effectiveWind (metar's own wind
  // vs ambientWx). The nested <Text>'s own style always applies on top of
  // the outer <Text>'s inherited colour (RN Text nesting, not a merged
  // style array), so a suitable end stays green even when the whole pill
  // is also selected/active (white).
  const runwayPicker = runways.length > 1 && (
    <View style={wxStyles.rwyPicker}>
      {[...runways].sort((a, b) => (b.length_m ?? 0) - (a.length_m ?? 0)).map((rwy) => {
        const isSelected = compassRunway?.designator === rwy.designator
        const windEnds = computeRunwayWind(rwy.thresholds ?? [], effectiveWind)
        return (
          <TouchableOpacity
            key={rwy.designator}
            style={[wxStyles.rwyPickerBtn, isSelected ? wxStyles.rwyPickerBtnActive : null]}
            onPress={() => setSelectedRunwayDesig(rwy.designator)}
          >
            <Text style={[wxStyles.rwyPickerTxt, isSelected ? wxStyles.rwyPickerTxtActive : null]}>
              {(rwy.thresholds ?? []).map((t, i) => {
                const end = windEnds.find((e) => e.designator === t.designator)
                const isSuitable = !!end?.favored && end.headwindKt != null && end.headwindKt >= 0 && end.crosswindSeverity === 'calm'
                // Slash is its own untinted Text sibling, never inside the
                // conditionally-green one -- a single Text node here would
                // colour the "/" green too whenever the SECOND end (i > 0)
                // happens to be the suitable one.
                return (
                  <Text key={t.designator}>
                    {i > 0 && <Text>/</Text>}
                    <Text style={isSuitable ? wxStyles.rwyPickerTxtSuitable : undefined}>{t.designator}</Text>
                  </Text>
                )
              })}
            </Text>
          </TouchableOpacity>
        )
      })}
    </View>
  )

  // Wind tile arrow (same as web): points where the wind blows TO.
  const windArrowDeg = effectiveWind && !effectiveWind.calm && effectiveWind.dirDeg != null ? effectiveWind.dirDeg + 180 : null

  // Header row: flight-rule badge + obs time/age right-aligned (METAR), or
  // "Modelled · now" (Weather station) — same layout as web's .wxHeader.
  const wxHeader = wxSource === 'metar' && metar ? (
    <>
      {metar.flightRule && FR_BADGE[metar.flightRule] && (
        <View style={[wxStyles.frBadge, { backgroundColor: FR_BADGE[metar.flightRule].bg }]}>
          <Text style={[wxStyles.frTxt, { color: FR_BADGE[metar.flightRule].fg }]}>{metar.flightRule}</Text>
        </View>
      )}
      {(metar.time || fmtObsAge(metar.obsMs)) && (
        <Text style={wxStyles.wxTime}>
          {metar.time ?? ''}{fmtObsAge(metar.obsMs) ? `${metar.time ? ' · ' : ''}${fmtObsAge(metar.obsMs)}` : ''}
        </Text>
      )}
    </>
  ) : wxSource === 'station' ? (
    <Text style={wxStyles.wxTime}>Modelled · now</Text>
  ) : undefined

  return (
    <>
      {/* Weather */}
      {/* No title: the popup's own "Weather" tab already names this section. */}
      <Section header={wxHeader}>
        {wxLoading && <ActivityIndicator size="small" color={theme.accentBlue} />}

        {/* METAR / Weather station toggle -- always both offered. METAR is
            icao's own report, auto-falling back to the nearest reporting
            station when icao has none. Weather station is Open-Meteo's
            non-aviation ambient reading, always available regardless of
            whether a real METAR exists anywhere. */}
        <View style={wxStyles.rwyPicker}>
          <TouchableOpacity
            style={[wxStyles.rwyPickerBtn, wxStyles.wxSourceBtn, wxSource === 'metar' ? wxStyles.rwyPickerBtnActive : null]}
            onPress={() => onSourceChange('metar')}
          >
            <Text style={[wxStyles.wxSourceTxt, wxSource === 'metar' ? wxStyles.rwyPickerTxtActive : null]}>METAR</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[wxStyles.rwyPickerBtn, wxStyles.wxSourceBtn, wxSource === 'station' ? wxStyles.rwyPickerBtnActive : null]}
            onPress={() => onSourceChange('station')}
          >
            <Text style={[wxStyles.wxSourceTxt, wxSource === 'station' ? wxStyles.rwyPickerTxtActive : null]}>Weather station</Text>
          </TouchableOpacity>
        </View>

        {wxSource === 'metar' && (
          <>
            {!wxLoading && !wx?.metar && !wx?.taf && (
              <Text style={styles.muted}>No METAR/TAF at {icao} or any nearby station — try Weather station above</Text>
            )}

            {/* Fallback banner -- shown whenever the METAR/TAF shown came
                from a different aerodrome than this one (icao has no
                report of its own). No silent wind-only swap to modelled
                data at any distance anymore -- that's what the Weather
                station tab is for; this banner just tells the pilot how
                far away the shown report actually is. */}
            {usingFallbackWx && wx && (
              <View style={wxStyles.fallbackBox}>
                <Text style={wxStyles.fallback}>
                  Showing <Text style={wxStyles.fallbackStrong}>{wx.sourceIcao}</Text>{wxSourceName ? ` (${wxSourceName})` : ''}
                  {wx.distNm != null ? `, ${Math.round(wx.distNm)} NM away` : ''} — not {icao}'s own report
                </Text>
              </View>
            )}

            {metar && (
              <>
                {runwayPicker}

                <View style={wxStyles.gaugeRow}>
                  <WindCompassGauge
                    wind={effectiveWind}
                    runway={primaryRunwayHeading}
                    tone={windTone(effectiveWind)}
                    favoredEndDesignator={compassFavoredEnd?.designator ?? null}
                  />
                  <WindSpeedGauge wind={effectiveWind} tone={windTone(effectiveWind)} />
                </View>

                <View style={wxStyles.tileGrid}>
                  <WxTile label="Wind" value={fmtWind(effectiveWind)} tone={windTone(effectiveWind)} arrowDeg={windArrowDeg} />
                  <WxTile label="Visibility" value={fmtVis(metar.visM)} tone={visTone(metar.visM)} />
                  <WxTile label="Ceiling" value={metar.ceilingFt != null ? `${metar.ceilingFt.toLocaleString()} ft` : metar.clouds === 'CAVOK' ? 'CAVOK' : 'No ceiling'} tone={ceilingTone(metar.ceilingFt)} />
                  <WxTile label="QNH" value={metar.qnh ? metar.qnh.slice(1) : '—'} tone="info" />
                  {metar.temp && <WxTile label="T / Td" value={`${metar.temp.replace('/', ' / ')}°C`} tone="info" />}
                  {metar.wx && <WxTile label="Wx" value={metar.wx} tone="warn" />}
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
                {tafChangeSoon(wx.taf) && (
                  <Text style={wxStyles.tafChange}>{'\u26a0'} Trend change due within 3 h</Text>
                )}
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
          </>
        )}

        {wxSource === 'station' && (
          <>
            {!ambientWx && (
              <Text style={styles.muted}>Weather station data unavailable (offline, or Open-Meteo outage)</Text>
            )}

            {ambientWx && (
              <>
                <View style={wxStyles.fallbackBox}>
                  <Text style={wxStyles.fallback}>
                    Modelled (Open-Meteo forecast)
                    {ambientWx.gridDistNm != null ? `, grid point ${fmtGridDist(ambientWx.gridDistNm)} from ${icao}` : ` at ${icao}'s coordinates`} — not an observed report.
                  </Text>
                </View>

                {runwayPicker}

                <View style={wxStyles.gaugeRow}>
                  <WindCompassGauge
                    wind={effectiveWind}
                    runway={primaryRunwayHeading}
                    tone={windTone(effectiveWind)}
                    favoredEndDesignator={compassFavoredEnd?.designator ?? null}
                  />
                  <WindSpeedGauge wind={effectiveWind} tone={windTone(effectiveWind)} />
                </View>

                <View style={wxStyles.tileGrid}>
                  <WxTile label={`Wind${windIsModelled ? ' (modelled)' : ''}`} value={fmtWind(effectiveWind)} tone={windTone(effectiveWind)} arrowDeg={windArrowDeg} />
                  {ambientWx.tempC != null && <WxTile label="Temp" value={`${ambientWx.tempC}°C`} tone="info" />}
                  {ambientWx.cloudPct != null && <WxTile label="Cloud cover" value={`${ambientWx.cloudPct}%`} tone="info" />}
                  {ambientWx.pressureHpa != null && <WxTile label="Surface pressure" value={`${ambientWx.pressureHpa} hPa`} tone="info" />}
                  {ambientWx.precipMm != null && ambientWx.precipMm > 0 && <WxTile label="Precip" value={`${ambientWx.precipMm} mm`} tone="warn" />}
                </View>
              </>
            )}
          </>
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

const TONE_BOX = {
  ok:     { bg: 'statusBoxOkBg',     border: 'statusBoxOkBorder',     text: 'statusBoxOkText' },
  warn:   { bg: 'statusBoxWarnBg',   border: 'statusBoxWarnBorder',   text: 'statusBoxWarnText' },
  danger: { bg: 'statusBoxDangerBg', border: 'statusBoxDangerBorder', text: 'statusBoxDangerText' },
  info:   { bg: 'statusBoxInfoBg',   border: 'statusBoxInfoBorder',   text: 'statusBoxInfoText' },
} as const

/** Tone-tinted metric box (bg + border + text) — same look as web's .wxTile. */
/** "<1 NM" / "3 NM" — model grid points are a few km from the aerodrome. */
function fmtGridDist(nm: number): string {
  return nm < 1 ? '<1 NM' : `${Math.round(nm)} NM`
}

function WxTile({ label, value, tone, arrowDeg }: { label: string; value: string; tone: keyof typeof TONE_BOX; arrowDeg?: number | null }) {
  const wxStyles = useThemedStyles(makeWxStyles)
  const t = TONE_BOX[tone]
  const color = theme[t.text]
  return (
    <View style={[wxStyles.tile, { backgroundColor: theme[t.bg], borderColor: theme[t.border] }]}>
      <Text style={[wxStyles.tileLabel, { color }]}>{label}</Text>
      <View style={wxStyles.tileValueRow}>
        {arrowDeg != null && (
          <Svg viewBox="0 0 24 24" style={[wxStyles.tileArrow, { transform: [{ rotate: `${arrowDeg % 360}deg` }] }]}>
            <Path d="M12 2 L18 14 L12 10.5 L6 14 Z" fill={color} />
          </Svg>
        )}
        <Text style={[wxStyles.tileValue, { color }, { flexShrink: 1 }]}>{value}</Text>
      </View>
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
  rawMetar: {
    color:      theme.textSecondary,
    fontSize:   theme.scale(10),
    marginTop:  theme.space2,
    fontFamily: 'monospace',
    lineHeight: theme.scale(14),
  },
  tafToggle: {
    marginTop: theme.space2,
  },
  tafToggleTxt: {
    color:    theme.accentBlue,
    fontSize: theme.textSm,
    fontWeight: '700',
  },
  tafText: {
    color:      theme.textSecondary,
    fontSize:   theme.scale(9),
    marginTop:  theme.space1,
    fontFamily: 'monospace',
    lineHeight: theme.scale(13),
  },
} as const
}

function makeWxStyles(theme: ScaledTheme) {
 return {
  frBadge: {
    borderRadius:      3,
    paddingHorizontal: 5,
    paddingVertical:   1,
  },
  frTxt: {
    fontSize:      theme.scale(10),
    fontWeight:    '700',
    letterSpacing: 0.8,
  },
  wxTime: {
    marginLeft:  'auto',
    color:       theme.textFaint,
    fontSize:    theme.textXs,
    fontVariant: ['tabular-nums'] as ('tabular-nums')[],
  },
  fallbackBox: {
    backgroundColor:   theme.statusBoxInfoBg,
    borderColor:       theme.statusBoxInfoBorder,
    borderWidth:       1,
    borderRadius:      5,
    paddingHorizontal: theme.space2,
    paddingVertical:   5,
    marginBottom:      theme.space2,
  },
  fallback: {
    color:      theme.statusBoxInfoText,
    fontSize:   theme.textSm,
    lineHeight: theme.textSm * 1.5,
  },
  fallbackStrong: {
    fontWeight: '700',
  },
  gaugeRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 18,
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
    justifyContent: 'center',
    gap: 4,
    marginBottom: theme.space2,
  },
  rwyPickerBtn: {
    backgroundColor: theme.surfaceHover,
    borderWidth: 1,
    borderColor: theme.borderDefault,
    borderRadius: theme.radiusSm,
    paddingHorizontal: theme.space2,
    paddingVertical: 3,
  },
  rwyPickerBtnActive: {
    backgroundColor: theme.tintBlueMid,
    borderColor: theme.accentBlue,
  },
  rwyPickerTxt: {
    color: theme.textMuted,
    fontSize: theme.textXs,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  // Wind-only "suitable" cue -- applied to the nested per-end <Text> only
  // (see runwayPicker's own doc comment), never the whole pill/border.
  rwyPickerTxtSuitable: {
    color: theme.accentGreen,
  },
  rwyPickerTxtActive: {
    color: theme.accentBlueBright,
  },
  // METAR/Weather-station toggle modifiers -- "Weather station" is much
  // longer than a 2-3 char runway designator, so it needs a smaller font
  // and tighter padding than the runway picker's own buttons (rwyPickerBtn/
  // rwyPickerTxt) to avoid an oversized pill.
  wxSourceBtn: {
    paddingHorizontal: 7,
  },
  wxSourceTxt: {
    color: theme.textMuted,
    fontSize: theme.scale(9),
    fontWeight: '600',
  },
  tileGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: theme.space2,
  },
  // 3 per row, equal width (web: auto-fit minmax(84px, 1fr)).
  tile: {
    width: '32%',
    gap: 2,
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  tileLabel: {
    fontSize: theme.scale(9),
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    opacity: 0.75,
  },
  tileValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  tileArrow: {
    width: theme.scale(12),
    height: theme.scale(12),
  },
  tileValue: {
    fontSize: theme.textMd,
    fontWeight: '700',
    fontVariant: ['tabular-nums'] as ('tabular-nums')[],
  },
  narrative: {
    color: theme.textSecondary,
    fontSize: theme.textSm,
    lineHeight: 19,
    marginTop: theme.space2,
  },
  tafChange: {
    color: '#f59e0b',
    fontSize: theme.textXs,
    fontWeight: '700',
    marginTop: 2,
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
    fontSize: theme.scale(9),
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
    fontSize: theme.scale(9),
    fontWeight: '700',
  },
  tafPeriodTime: {
    color: theme.textFaint,
    fontSize: theme.scale(9),
  },
  tafPeriodBody: {
    color: theme.textSecondary,
    fontSize: theme.scale(10),
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
