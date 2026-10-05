/**
 * GaugesBar — the "gauges" instrument strip: GS · T.ALT (tap to toggle
 * AMSL/AGL) · TT · UTC · WIND dir. Always visible at the bottom of the map
 * screen — VerticalProfile is draggable above it but this bar itself never
 * scrolls away.
 */

import React, { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import type { GpsPosition } from '../utils/gpsTypes'
import type { WindAloft } from '@open-vfr/shared/fetchWind'
import { computeWindRelative } from '@open-vfr/shared/windRelative'
import type { AltitudeSourceResult } from '@open-vfr/shared/baroAltitude'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'

type Props = {
  position: GpsPosition | null
  agl:      number | null
  wind:     WindAloft | null
  showAgl:  boolean
  onToggleAgl: () => void
  /** Barometric altitude source (tier 1/2) — undefined/tier==='gps' hides the P.ALT/VS gauges entirely. */
  altitudeSource?: AltitudeSourceResult
  /** P.ALT gauge: show QNH (hPa) instead of the FL/altitude value — tap to toggle, same pattern as T.ALT's AMSL/AGL toggle. */
  showQnh?: boolean
  onToggleQnh?: () => void
  /** UTC gauge: show local device time instead of Zulu — tap to toggle. */
  showLocalTime?: boolean
  onToggleLocalTime?: () => void
  /** Connected BlueFly's battery is critically low — flags the P.ALT gauge so a dying vario is noticed in-flight, not just when checking Settings. */
  varioBatteryLow?: boolean
}

function useClock(local: boolean): string {
  const [time, setTime] = useState('')
  useEffect(() => {
    const tick = () => {
      const d = new Date()
      const h = local ? d.getHours()   : d.getUTCHours()
      const m = local ? d.getMinutes() : d.getUTCMinutes()
      setTime(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [local])
  return time
}

function Gauge({ value, label, onPress, valueColor }: { value: string; label: string; onPress?: () => void; valueColor?: string }) {
  const styles = useThemedStyles(makeStyles)
  const Wrapper = onPress ? TouchableOpacity : View
  return (
    <Wrapper style={styles.gauge} onPress={onPress} activeOpacity={0.6}>
      <Text style={[styles.gaugeValue, valueColor ? { color: valueColor } : null]} allowFontScaling={false} numberOfLines={1}>{value}</Text>
      <Text style={styles.gaugeLabel} numberOfLines={1}>{label}</Text>
    </Wrapper>
  )
}

// Crosswind severity colour — same thresholds as web's GoFlyingPanel.tsx,
// both sourced from @open-vfr/shared/windRelative so the two apps can't
// drift apart (see AGENTS.md's shared-colour-source rule). Headwind/
// tailwind is intentionally NOT colour-coded — tailwind is a bonus enroute
// but dangerous on landing, so a universal red/green would be misleading;
// only crosswind (unfavourable in every flight phase) gets a colour tier.
function crosswindColor(severity: 'calm' | 'moderate' | 'strong'): string {
  if (severity === 'strong') return theme.statusDanger
  if (severity === 'moderate') return theme.statusWarn
  return theme.statusOk
}

/**
 * WindGauge — shows wind direction/speed plus a rotated arrow indicating
 * which way the wind is blowing relative to the aircraft's nose (up =
 * tailwind pushing you forward, down = headwind opposing you). The arrow
 * itself is neutral-coloured — direction only. Colour instead reflects
 * crosswind severity (green/yellow/red), the one component that's
 * unfavourable regardless of flight phase.
 */
function WindGauge({ wind, position }: { wind: WindAloft | null; position: GpsPosition | null }) {
  const styles = useThemedStyles(makeStyles)
  const windTxt = wind ? `${wind.dirDeg.toString().padStart(3, '0')}\u00b0/${Math.round(wind.speedKts)}` : '\u2013'
  const rel = position ? computeWindRelative(wind, position.trackDeg, position.speedKts) : null
  const xwColor = rel ? crosswindColor(rel.crosswindSeverity) : undefined
  return (
    <View style={styles.gauge}>
      <View style={styles.windValueRow}>
        {rel && (
          <Text style={[styles.windArrow, { transform: [{ rotate: `${rel.arrowRotationDeg}deg` }] }]}>
            {'\u25b2'}
          </Text>
        )}
        <Text style={styles.gaugeValue} allowFontScaling={false} numberOfLines={1}>{windTxt}</Text>
      </View>
      <Text style={[styles.gaugeLabel, xwColor ? { color: xwColor } : null]} numberOfLines={1}>
        {rel ? (rel.hw >= 0 ? `HW${rel.hw}` : `TW${Math.abs(rel.hw)}`) + ` \u00b7 XW${rel.xw}` : 'WIND'}
      </Text>
    </View>
  )
}

export function GaugesBar({ position, agl, wind, showAgl, onToggleAgl, altitudeSource, showQnh, onToggleQnh, showLocalTime, onToggleLocalTime, varioBatteryLow }: Props) {
  const styles = useThemedStyles(makeStyles)
  const clock = useClock(!!showLocalTime)

  const gs = position ? `${Math.round(position.speedKts)}` : '\u2013'
  const tt = position ? `${Math.round(position.trackDeg).toString().padStart(3, '0')}\u00b0` : '\u2013'

  const talt = (() => {
    if (!position) return '\u2013'
    if (showAgl) {
      if (agl == null) return '\u2013'
      return `${Math.round(position.altFt - agl)}`
    }
    return `${Math.round(position.altFt)}`
  })()

  const hasBaro = altitudeSource != null && altitudeSource.tier !== 'gps' && altitudeSource.altFt != null
  const isVarioLow = varioBatteryLow && altitudeSource?.tier === 'baro-vario'
  const tierIcon = isVarioLow
    ? '\u26a0'
    : altitudeSource?.tier === 'baro-vario' ? '\u25c6' : altitudeSource?.tier === 'baro-internal' ? '\u25cb' : ''

  const uncalibrated = hasBaro && altitudeSource.tier === 'baro-internal' && !altitudeSource.qnhCalibrated

  const paltAltText = hasBaro
    ? (() => {
        const ft = Math.round(altitudeSource!.altFt!)
        return ft >= 1000 ? `FL${Math.round(ft / 100).toString().padStart(3, '0')}` : `${ft}`
      })()
    : null

  const palt = hasBaro
    ? (showQnh ? `${Math.round(altitudeSource!.qnhHpa)}` : paltAltText)
    : null

  const vs = hasBaro && altitudeSource!.vsFtMin != null
    ? `${altitudeSource!.vsFtMin! >= 0 ? '+' : ''}${Math.round(altitudeSource!.vsFtMin!)}`
    : null

  return (
    <View style={styles.bar}>
      <Gauge value={talt} label={showAgl ? 'T.ALT AGL' : 'T.ALT AMSL'} onPress={onToggleAgl} />
      {palt != null && (
        <>
          <View style={styles.divider} />
          <Gauge
            value={palt}
            label={`${tierIcon} ${showQnh ? 'QNH' : 'P.ALT'}${uncalibrated ? ' ?' : ''}`}
            onPress={onToggleQnh}
            valueColor={isVarioLow ? theme.statusDanger : uncalibrated ? theme.statusWarn : undefined}
          />
        </>
      )}
      {vs != null && (
        <>
          <View style={styles.divider} />
          <Gauge value={vs} label="VS fpm" />
        </>
      )}
      <View style={styles.divider} />
      <Gauge value={gs} label="GS" />
      <View style={styles.divider} />
      <Gauge value={tt} label="TT" />
      <View style={styles.divider} />
      <Gauge value={clock} label={showLocalTime ? 'LT' : 'UTC'} onPress={onToggleLocalTime} />
      <View style={styles.divider} />
      <WindGauge wind={wind} position={position} />
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  bar: {
    flexDirection:   'row' as const,
    alignItems:      'center' as const,
    justifyContent:  'space-evenly' as const,
    backgroundColor: theme.surfacePanel,
    borderTopWidth:  1,
    borderColor:     theme.borderDefault,
    paddingVertical: theme.space2,
  },
  gauge: {
    flex:       1,
    alignItems: 'center' as const,
  },
  gaugeValue: {
    color:      theme.textPrimary,
    fontSize:   theme.textLg,
    fontWeight: '700' as const,
  },
  gaugeLabel: {
    color:    theme.textMuted,
    fontSize: theme.scale(9),
    marginTop: 1,
  },
  windValueRow: {
    flexDirection: 'row' as const,
    alignItems:    'center' as const,
  },
  windArrow: {
    fontSize:    theme.scale(9),
    marginRight: 2,
    color:       theme.textSecondary,
  },
  divider: {
    width:            1,
    height:           '60%' as const,
    backgroundColor:  theme.borderSubtle,
  },
 }
}
