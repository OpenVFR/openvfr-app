/**
 * PastTrackChart — post-flight altitude + ground speed review chart for a
 * completed flight log ("View" action in PlanScreen's Logs segment).
 *
 * Native parity for web's LiveTrackChart.tsx (same visual language: green
 * altitude line, cyan dashed speed line, distance-flown X axis) — built with
 * react-native-svg since native has no Recharts/DOM. Deliberately simpler
 * than VerticalProfile (no airspace/terrain/MSA — this is a historical
 * review of what was actually flown, not a planning tool), same draggable
 * height convention (height/onHeightChange) so it slots into MapScreen's
 * existing bottom-stack footprint alongside VerticalProfile.
 *
 * Touch-drag over the chart plot area scrubs a crosshair (in-chart, via
 * onHoverDistNm) so the parent screen can sync a map-side marker — native
 * equivalent of web's Recharts onMouseMove/onMouseLeave.
 */

import React, { useMemo, useState, useRef, useCallback } from 'react'
import {
  View, StyleSheet, PanResponder, type LayoutChangeEvent,
} from 'react-native'
import Svg, { Path, Line as SvgLine, Defs, LinearGradient, Stop } from 'react-native-svg'

import type { TrackPoint } from '../types/db'
import { theme } from '../styles/theme'
import { DEFAULT_CHART_H, MIN_CHART_H, MAX_CHART_H, COLLAPSE_THRESHOLD } from './VerticalProfile'

const NM_PER_DEG_LAT = 60.0

function quickDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * NM_PER_DEG_LAT
  const dLng = (lng2 - lng1) * NM_PER_DEG_LAT * Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

interface ChartPoint {
  distNm: number
  altFt:  number
  spdKts: number
}

interface Props {
  track: TrackPoint[]
  height?: number
  onHeightChange?: (h: number) => void
  /** Called with the distance-along-track (NM) under the finger while
   *  touch-dragging the chart plot area, and with null on release — lets
   *  the parent screen sync a crosshair marker on the map. */
  onHoverDistNm?: (nm: number | null) => void
}

const MARGIN_L = 34
const MARGIN_R = 30
const MARGIN_T = 10
const MARGIN_B = 18

function niceStep(range: number, targetTicks: number): number {
  if (range <= 0) return 500
  const raw = range / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  let step: number
  if (norm < 1.5) step = 1
  else if (norm < 3) step = 2
  else if (norm < 7) step = 5
  else step = 10
  return Math.max(500, step * mag)
}

function niceYTicks(yMax: number, targetTicks = 4): number[] {
  const step = niceStep(yMax, targetTicks)
  const ticks: number[] = []
  for (let v = 0; v <= yMax + 1e-6; v += step) ticks.push(Math.round(v))
  return ticks
}

export function PastTrackChart({ track, height = DEFAULT_CHART_H, onHeightChange, onHoverDistNm }: Props) {
  const [chartW, setChartW] = useState(0)
  const [hoverNm, setHoverNm] = useState<number | null>(null)
  const chartH    = Math.max(0, height)
  const collapsed = chartH <= COLLAPSE_THRESHOLD

  // Drag handle — same singleton-PanResponder pattern as VerticalProfile
  // (must not be recreated mid-gesture, see that file's comment for why).
  const chartHRef = useRef(chartH)
  chartHRef.current = chartH
  const onHeightChangeRef = useRef(onHeightChange)
  onHeightChangeRef.current = onHeightChange
  const dragStartHeightRef = useRef(chartH)
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { dragStartHeightRef.current = chartHRef.current },
    onPanResponderMove: (_, gs) => {
      const next = Math.max(MIN_CHART_H, Math.min(MAX_CHART_H, dragStartHeightRef.current - gs.dy))
      onHeightChangeRef.current?.(next)
    },
  }), [])

  const data = useMemo((): ChartPoint[] => {
    if (track.length === 0) return []
    const pts: ChartPoint[] = []
    let cumDist = 0
    for (let i = 0; i < track.length; i++) {
      if (i > 0) cumDist += quickDistNm(track[i - 1].lat, track[i - 1].lng, track[i].lat, track[i].lng)
      pts.push({
        distNm: Math.round(cumDist * 10) / 10,
        altFt:  Math.round(track[i].altFt),
        spdKts: Math.round(track[i].spdKts),
      })
    }
    return pts
  }, [track])

  const totalNm  = data.length > 0 ? data[data.length - 1].distNm : 0
  const maxAltFt = Math.max(200, ...data.map(d => d.altFt))
  const maxSpdKt = Math.max(20, ...data.map(d => d.spdKts))
  const yMax     = Math.ceil(maxAltFt / 500) * 500

  const plotW = Math.max(0, chartW - MARGIN_L - MARGIN_R)
  const plotH = chartH - MARGIN_T - MARGIN_B

  const xOf = useCallback((distNm: number) => MARGIN_L + (totalNm > 0 ? (distNm / totalNm) * plotW : 0), [totalNm, plotW])
  const yOfAlt = useCallback((altFt: number) => MARGIN_T + plotH - (yMax > 0 ? (altFt / yMax) * plotH : 0), [yMax, plotH])
  const yOfSpd = useCallback((spdKts: number) => MARGIN_T + plotH - (maxSpdKt > 0 ? (spdKts / maxSpdKt) * plotH : 0), [maxSpdKt, plotH])

  // Touch-drag scrub over the chart plot area — native equivalent of web's
  // LiveTrackChart onMouseMove/onMouseLeave. Singleton PanResponder, same
  // ref-based pattern as the resize-drag one above (must not be recreated
  // mid-gesture, see VerticalProfile's comment for the full reasoning).
  const totalNmRef = useRef(totalNm); totalNmRef.current = totalNm
  const plotWRef = useRef(plotW); plotWRef.current = plotW
  const onHoverDistNmRef = useRef(onHoverDistNm); onHoverDistNmRef.current = onHoverDistNm
  const updateHover = useCallback((locationX: number) => {
    const tNm = totalNmRef.current, pW = plotWRef.current
    if (tNm <= 0 || pW <= 0) return
    const nm = Math.max(0, Math.min(tNm, ((locationX - MARGIN_L) / pW) * tNm))
    setHoverNm(nm)
    onHoverDistNmRef.current?.(nm)
  }, [])
  const clearHover = useCallback(() => { setHoverNm(null); onHoverDistNmRef.current?.(null) }, [])
  const scrubResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => updateHover(e.nativeEvent.locationX),
    onPanResponderMove: (e) => updateHover(e.nativeEvent.locationX),
    onPanResponderRelease: () => clearHover(),
    onPanResponderTerminate: () => clearHover(),
  }), [updateHover, clearHover])

  const altPath = useMemo(() => {
    if (data.length === 0 || plotW <= 0) return ''
    return `M${data.map(d => `${xOf(d.distNm).toFixed(1)},${yOfAlt(d.altFt).toFixed(1)}`).join(' L')}`
  }, [data, plotW, xOf, yOfAlt])

  const spdPath = useMemo(() => {
    if (data.length === 0 || plotW <= 0) return ''
    return `M${data.map(d => `${xOf(d.distNm).toFixed(1)},${yOfSpd(d.spdKts).toFixed(1)}`).join(' L')}`
  }, [data, plotW, xOf, yOfSpd])

  const onChartLayout = useCallback((e: LayoutChangeEvent) => {
    setChartW(e.nativeEvent.layout.width)
  }, [])

  if (data.length < 2) return null

  const yTicks = niceYTicks(yMax)

  return (
    <View style={[styles.panel, collapsed && styles.panelCollapsed]}>
      <View style={styles.dragHandle} {...panResponder.panHandlers}>
        <View style={styles.dragGrip} />
      </View>
      {!collapsed && (
        <View style={[styles.chartWrap, { height: chartH }]} onLayout={onChartLayout} {...scrubResponder.panHandlers}>
          {chartW > 0 && (
            <Svg width={chartW} height={chartH}>
              <Defs>
                <LinearGradient id="pastSky" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0%"  stopColor="#0d1424" stopOpacity={1} />
                  <Stop offset="100%" stopColor="#1a2338" stopOpacity={1} />
                </LinearGradient>
              </Defs>
              <Path d={`M0,0 L${chartW},0 L${chartW},${chartH} L0,${chartH} Z`} fill="url(#pastSky)" />

              {yTicks.map((ft, i) => (
                <SvgLine key={`yg-${i}`} x1={MARGIN_L} y1={yOfAlt(ft)} x2={chartW - MARGIN_R} y2={yOfAlt(ft)}
                  stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
              ))}

              <Path d={altPath} fill="none" stroke="#4ade80" strokeWidth={1.5} />
              <Path d={spdPath} fill="none" stroke="#22d3ee" strokeWidth={1} strokeDasharray="4,3" />

              {hoverNm != null && (
                <SvgLine x1={xOf(hoverNm)} y1={MARGIN_T} x2={xOf(hoverNm)} y2={MARGIN_T + plotH}
                  stroke="rgba(250,204,21,0.85)" strokeWidth={1.5} strokeDasharray="4,3" />
              )}
            </Svg>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: theme.surfacePanel,
    borderTopWidth:  1,
    borderColor:     theme.borderDefault,
  },
  panelCollapsed: {},
  dragHandle: {
    height:          22,
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    backgroundColor: theme.surfaceOverlay,
  },
  dragGrip: {
    width:           48,
    height:          5,
    borderRadius:    3,
    backgroundColor: theme.textMuted,
  },
  chartWrap: {},
})
