/**
 * GaugesBar — the "gauges" instrument strip: GS · T.ALT (tap to toggle
 * AMSL/AGL) · TT · UTC · WIND dir. Always visible at the bottom of the map
 * screen — VerticalProfile is draggable above it but this bar itself never
 * scrolls away.
 */

import React, { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, type LayoutChangeEvent } from 'react-native'
import type { GpsPosition } from '../utils/gpsTypes'
import type { WindAloft } from '@open-vfr/shared/fetchWind'
import { computeWindRelative } from '@open-vfr/shared/windRelative'
import type { AltitudeSourceResult } from '@open-vfr/shared/baroAltitude'
import { theme, useThemedStyles, useScaledTheme, type ScaledTheme } from '../styles/theme'

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
  /** A barometric source is enabled/connected. When it isn't delivering data the P.ALT gauge stays visible with a gray dot instead of vanishing. */
  baroExpected?: boolean
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

/** Per-gauge layout computed by GaugesBar: relative width weight + shared font sizes. */
type GaugeSizing = { weight: number; valueSize: number; labelSize: number }

function Gauge({ value, label, sizing, onPress, valueColor, dotColor, dotGlyph }: {
  value: string; label: string; sizing: GaugeSizing; onPress?: () => void; valueColor?: string; dotColor?: string; dotGlyph?: string
}) {
  const styles = useThemedStyles(makeStyles)
  const Wrapper = onPress ? TouchableOpacity : View
  return (
    <Wrapper style={[styles.gauge, { flexGrow: sizing.weight }]} onPress={onPress} activeOpacity={0.6}>
      <Text
        style={[styles.gaugeValue, { fontSize: sizing.valueSize }, valueColor ? { color: valueColor } : null]}
        allowFontScaling={false} numberOfLines={1}
      >{value}</Text>
      <Text style={[styles.gaugeLabel, { fontSize: sizing.labelSize }]} allowFontScaling={false} numberOfLines={1}>
        {dotColor ? <Text style={{ color: dotColor }}>{`${dotGlyph ?? '\u25cf'} `}</Text> : null}{label}
      </Text>
    </Wrapper>
  )
}

// Approximate glyph widths as a fraction of font size (bold digits / regular caps).
const VALUE_EM_PER_CHAR = 0.6
const LABEL_EM_PER_CHAR = 0.56

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
function WindGauge({ windTxt, label, rel, xwColor, sizing }: {
  windTxt: string
  label: string
  rel: ReturnType<typeof computeWindRelative> | null
  xwColor: string | undefined
  sizing: GaugeSizing
}) {
  const styles = useThemedStyles(makeStyles)
  return (
    <View style={[styles.gauge, { flexGrow: sizing.weight }]}>
      <View style={styles.windValueRow}>
        {rel && (
          <Text style={[styles.windArrow, { fontSize: sizing.labelSize, transform: [{ rotate: `${rel.arrowRotationDeg}deg` }] }]}>
            {'\u25b2'}
          </Text>
        )}
        <Text style={[styles.gaugeValue, { fontSize: sizing.valueSize }]} allowFontScaling={false} numberOfLines={1}>{windTxt}</Text>
      </View>
      <Text style={[styles.gaugeLabel, { fontSize: sizing.labelSize }, xwColor ? { color: xwColor } : null]} allowFontScaling={false} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

export function GaugesBar({ position, agl, wind, showAgl, onToggleAgl, altitudeSource, showQnh, onToggleQnh, showLocalTime, onToggleLocalTime, varioBatteryLow, baroExpected }: Props) {
  const styles = useThemedStyles(makeStyles)
  const clock = useClock(!!showLocalTime)
  const scaled = useScaledTheme()
  const [barWidth, setBarWidth] = useState(0)
  const onLayout = (e: LayoutChangeEvent) => setBarWidth(e.nativeEvent.layout.width)

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
  // Colour = health (green live+calibrated, amber live but QNH unverified,
  // gray enabled but no data). Shape = source (filled = BlueFly, outline = phone).
  // Low BlueFly battery keeps its own warning marker.
  const baroGlyph = altitudeSource?.tier === 'baro-vario' ? '\u25cf' : '\u25cb'
  const baroDot = !hasBaro ? theme.textMuted : altitudeSource?.qnhCalibrated === false ? theme.statusWarn : theme.statusOk

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

  const windTxt = wind ? `${wind.dirDeg.toString().padStart(3, '0')}\u00b0/${Math.round(wind.speedKts)}` : '\u2013'
  const rel = position ? computeWindRelative(wind, position.trackDeg, position.speedKts) : null
  const xwColor = rel ? crosswindColor(rel.crosswindSeverity) : undefined
  const windLabel = rel ? (rel.hw >= 0 ? `HW${rel.hw}` : `TW${Math.abs(rel.hw)}`) + ` \u00b7 XW${rel.xw}` : 'WIND'

  // minChars: widest reading this gauge can show (GS up to 3 digits, P.ALT up
  // to "FL195", VS up to "+1500"...). Sizing uses max(actual, minChars) so the
  // font stays steady as digits come and go instead of jumping on 99 -> 100.
  type Item = { key: string; value: string; label: string; minChars: number; minLabelChars?: number; onPress?: () => void; valueColor?: string; dotColor?: string; dotGlyph?: string }
  const items: Item[] = [
    { key: 'talt', value: talt, label: showAgl ? 'T.ALT AGL' : 'T.ALT AMSL', minChars: 5, onPress: onToggleAgl },
  ]
  if (palt != null || baroExpected) {
    items.push({
      key: 'palt', value: palt ?? '\u2013', minChars: 5,
      label: `${isVarioLow ? '\u26a0 ' : ''}${showQnh ? 'QNH' : 'P.ALT'}${uncalibrated ? ' ?' : ''}`,
      dotColor: baroDot, dotGlyph: baroGlyph,
      onPress: onToggleQnh,
      valueColor: isVarioLow ? theme.statusDanger : uncalibrated ? theme.statusWarn : undefined,
    })
  }
  if (vs != null) items.push({ key: 'vs', value: vs, label: 'VS fpm', minChars: 5 })
  items.push(
    { key: 'gs', value: gs, label: 'GS', minChars: 3 },
    { key: 'tt', value: tt, label: 'TT', minChars: 4 },
    { key: 'clock', value: clock || '00:00', label: showLocalTime ? 'LT' : 'UTC', minChars: 5, onPress: onToggleLocalTime },
    { key: 'wind', value: windTxt + (rel ? '  ' : ''), label: windLabel, minChars: 7, minLabelChars: 9 },
  )

  // Fit the strip to the device width: each gauge gets a width share in
  // proportion to its text, then one shared value size and one shared label
  // size are chosen so the tightest gauge still fits. Text therefore grows and
  // shrinks with the screen instead of truncating (capped so a wide tablet
  // doesn't get absurdly large numerals; the device/user scale already applies
  // to the caps).
  const valueChars = (it: Item) => Math.max(it.value.length, it.minChars)
  const labelChars = (it: Item) => Math.max(it.label.length, it.minLabelChars ?? 0)
  const textLen = (it: Item) => Math.max(valueChars(it) * VALUE_EM_PER_CHAR, labelChars(it) * LABEL_EM_PER_CHAR * 0.62, 1.8)
  const weights = items.map(textLen)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const usable = Math.max(0, barWidth - (items.length - 1) - scaled.space2) // dividers + a little edge padding
  let valueSize = scaled.textXl
  let labelSize = scaled.scale(11)
  if (usable > 0) {
    items.forEach((it, i) => {
      const slot = (usable * weights[i]) / totalWeight
      valueSize = Math.min(valueSize, (slot * 0.94) / (valueChars(it) * VALUE_EM_PER_CHAR))
      labelSize = Math.min(labelSize, (slot * 0.96) / (labelChars(it) * LABEL_EM_PER_CHAR))
    })
  }
  valueSize = Math.max(valueSize, 9)
  labelSize = Math.max(labelSize, 6)

  return (
    <View style={styles.bar} onLayout={onLayout}>
      {items.map((it, i) => {
        const sizing: GaugeSizing = { weight: weights[i], valueSize, labelSize }
        return (
          <React.Fragment key={it.key}>
            {i > 0 && <View style={styles.divider} />}
            {it.key === 'wind'
              ? <WindGauge windTxt={windTxt} label={windLabel} rel={rel} xwColor={xwColor} sizing={sizing} />
              : <Gauge value={it.value} label={it.label} sizing={sizing} onPress={it.onPress} valueColor={it.valueColor} dotColor={it.dotColor} dotGlyph={it.dotGlyph} />}
          </React.Fragment>
        )
      })}
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  bar: {
    flexDirection:   'row' as const,
    alignItems:      'center' as const,
    justifyContent:  'space-evenly' as const,
    paddingHorizontal: theme.space1,
    backgroundColor: theme.surfacePanel,
    borderTopWidth:  1,
    borderColor:     theme.borderDefault,
    paddingVertical: theme.space2,
  },
  gauge: {
    flexBasis:  0,
    flexShrink: 1,
    alignItems: 'center' as const,
    minWidth:   0,
  },
  gaugeValue: {
    color:      theme.textPrimary,
    fontWeight: '700' as const,
  },
  gaugeLabel: {
    color:    theme.textMuted,
    marginTop: 1,
  },
  windValueRow: {
    flexDirection: 'row' as const,
    alignItems:    'center' as const,
  },
  windArrow: {
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
