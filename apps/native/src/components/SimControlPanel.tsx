/**
 * SimControlPanel — touch controls for internal flight simulation
 * (useSimFlight), shown only while that mode is active.
 *
 * Native has no keyboard, so control is redesigned around touch:
 *   - HDG/SPEED/ALT +/- buttons apply one discrete step per tap
 *     (HDG_STEP_DEG/SPEED_STEP_KTS/ALT_STEP_FT from the shared engine).
 *     Holding a button repeats the step at an accelerating rate (starts
 *     slow, speeds up the longer it's held) via useHoldRepeat below —
 *     the touch equivalent of holding an arrow key on web, but tuned as
 *     discrete steps + JS-timer repeat instead of a continuous per-tick
 *     ramp (see SimFlightEngine's header comment for why the continuous
 *     ramp was replaced — it could cascade into React update-depth errors
 *     when held).
 *   - ADV +1NM for a quick fast-forward jump (web's 'Q' key equivalent)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, TouchableOpacity, type LayoutChangeEvent } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

type Props = {
  speedKts: number
  altFt:    number
  trackDeg: number
  onAdjustHeading: (dir: -1 | 1) => void
  onAdjustSpeed:   (dir: -1 | 1) => void
  onAdjustAlt:     (dir: -1 | 1) => void
  onAdvance:  () => void
  onStop: () => void
}

// Hold-to-repeat tuning: one immediate step on press, then repeats
// starting at HOLD_DELAY_MS after the initial press, accelerating from
// START_INTERVAL_MS down to MIN_INTERVAL_MS.
const HOLD_DELAY_MS     = 350
const START_INTERVAL_MS = 220
const MIN_INTERVAL_MS   = 60
const ACCEL_STEP_MS     = 20

/** Press-and-hold-to-repeat-faster, for a single-arg (dir) step function. */
function useHoldRepeat(fn: (dir: -1 | 1) => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }, [])

  const press = useCallback((dir: -1 | 1) => {
    clear()
    fn(dir)  // immediate single step so a quick tap always does something visible
    let interval = START_INTERVAL_MS
    const repeat = () => {
      fn(dir)
      interval = Math.max(MIN_INTERVAL_MS, interval - ACCEL_STEP_MS)
      timerRef.current = setTimeout(repeat, interval)
    }
    timerRef.current = setTimeout(repeat, HOLD_DELAY_MS)
  }, [fn, clear])

  useEffect(() => clear, [clear])

  return { onPressIn: press, onPressOut: clear }
}

function StepperButton({ onPressIn, onPressOut, size, children }: {
  onPressIn:  () => void
  onPressOut: () => void
  size:       number
  children:   React.ReactNode
}) {
  const styles = useThemedStyles(makeStyles)
  return (
    <TouchableOpacity
      style={[styles.stepBtn, { width: size, height: size }]}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      activeOpacity={0.6}
    >
      {children}
    </TouchableOpacity>
  )
}

// Approximate glyph width as a fraction of font size (bold digits).
const EM_PER_CHAR = 0.6
// Units render smaller than the number next to them.
const UNIT_SCALE = 0.7

type ColumnSpec = { key: 'hdg' | 'spd' | 'alt'; label: string; digits: number; unit: string }
// Expected widest reading per column, so the layout doesn't jitter as values change.
const COLUMNS: ColumnSpec[] = [
  { key: 'hdg', label: 'HDG',   digits: 3, unit: '\u00b0' },
  { key: 'spd', label: 'SPEED', digits: 3, unit: ' kt' },
  { key: 'alt', label: 'ALT',   digits: 5, unit: ' ft' },
]
const textEm = (c: ColumnSpec, digits: number) => Math.max(digits, c.digits) * EM_PER_CHAR + c.unit.length * EM_PER_CHAR * UNIT_SCALE

export function SimControlPanel({ speedKts, altFt, trackDeg, onAdjustHeading, onAdjustSpeed, onAdjustAlt, onAdvance, onStop }: Props) {
  const styles = useThemedStyles(makeStyles)
  const hdg   = useHoldRepeat(onAdjustHeading)
  const speed = useHoldRepeat(onAdjustSpeed)
  const alt   = useHoldRepeat(onAdjustAlt)
  const scaled = useScaledTheme()
  const [rowWidth, setRowWidth] = useState(0)
  const onRowLayout = (e: LayoutChangeEvent) => setRowWidth(e.nativeEvent.layout.width)

  // Fit the controls to the screen: the +/- buttons scale with the width, the
  // three columns share the remaining space in proportion to their text, and
  // one font size is chosen so the tightest column's reading still fits.
  const rowGap = scaled.space1
  const innerGap = scaled.space1
  const btn = Math.max(22, Math.min(scaled.scale(30), Math.round(rowWidth * 0.065)))
  const digitsNow = { hdg: 3, spd: String(Math.round(speedKts)).length, alt: String(Math.round(altFt)).length }
  const fixed = 2 * btn + 2 * innerGap          // two buttons + gaps per column
  const ems = COLUMNS.map((c) => textEm(c, digitsNow[c.key]))
  const emSum = ems.reduce((x, y) => x + y, 0)
  // Closed-form fit: columns are fixed + em_i * f wide; choose the largest f
  // (font size) so the three columns exactly fill the row.
  const fitSize = rowWidth > 0
    ? (rowWidth - rowGap * (COLUMNS.length - 1) - COLUMNS.length * fixed) / emSum
    : scaled.textLg
  const valueSize = Math.max(9, Math.min(scaled.textLg, fitSize))
  const weights = ems.map((em) => fixed + em * valueSize)
  const unitSize = Math.max(8, Math.round(valueSize * UNIT_SCALE))
  const labelSize = Math.max(8, Math.min(scaled.scale(10), Math.round(valueSize * 0.7)))

  const values: Record<ColumnSpec['key'], { text: string; unit: string; minus: () => void; plus: () => void; onOut: () => void }> = {
    hdg: { text: Math.round(trackDeg).toString().padStart(3, '0'), unit: '\u00b0', minus: () => hdg.onPressIn(-1), plus: () => hdg.onPressIn(1), onOut: hdg.onPressOut },
    spd: { text: String(Math.round(speedKts)), unit: ' kt', minus: () => speed.onPressIn(-1), plus: () => speed.onPressIn(1), onOut: speed.onPressOut },
    alt: { text: String(Math.round(altFt)), unit: ' ft', minus: () => alt.onPressIn(-1), plus: () => alt.onPressIn(1), onOut: alt.onPressOut },
  }

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Ionicons name="game-controller-outline" size={14} color={theme.accentBlue} />
        <Text style={styles.headerTxt}>SIMULATION</Text>
        <TouchableOpacity style={styles.advBtn} onPress={onAdvance} hitSlop={6}>
          <Ionicons name="play-skip-forward-outline" size={14} color={theme.accentBlue} />
          <Text style={[styles.advTxt, { fontSize: labelSize }]} allowFontScaling={false}>+1NM</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onStop} hitSlop={8} testID="sim-stop">
          <Ionicons name="close-circle" size={18} color={theme.statusDanger} />
        </TouchableOpacity>
      </View>

      <View style={styles.row} onLayout={onRowLayout}>
        {COLUMNS.map((c, i) => {
          const v = values[c.key]
          return (
            <View key={c.key} style={[styles.gauge, { flexGrow: weights[i], flexBasis: 0 }]}>
              <Text style={[styles.gaugeLabel, { fontSize: labelSize }]} allowFontScaling={false}>{c.label}</Text>
              <View style={styles.stepperRow}>
                <StepperButton size={btn} onPressIn={v.minus} onPressOut={v.onOut}>
                  <Ionicons name="remove" size={Math.round(btn * 0.6)} color={theme.textPrimary} />
                </StepperButton>
                <Text style={[styles.gaugeVal, { fontSize: valueSize }]} allowFontScaling={false} numberOfLines={1}>
                  {v.text}<Text style={[styles.gaugeUnit, { fontSize: unitSize }]}>{v.unit}</Text>
                </Text>
                <StepperButton size={btn} onPressIn={v.plus} onPressOut={v.onOut}>
                  <Ionicons name="add" size={Math.round(btn * 0.6)} color={theme.textPrimary} />
                </StepperButton>
              </View>
            </View>
          )
        })}
      </View>
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  panel: {
    backgroundColor: theme.surfacePanel,
    borderTopWidth:  1,
    borderColor:     theme.borderDefault,
    paddingHorizontal: theme.space3,
    paddingVertical:   theme.space2,
    gap: theme.space1,
  },
  header: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           theme.space1,
  },
  headerTxt: {
    flex:       1,
    color:      theme.textPrimary,
    fontSize:   theme.textXs,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           theme.space2,
  },
  gauge: {
    minWidth: 0,
    alignItems: 'center',
    gap: 2,
  },
  gaugeLabel: {
    color:      theme.textMuted,
    fontWeight: '600',
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           theme.space1,
  },
  stepBtn: {
    borderRadius:    theme.radiusSm,
    backgroundColor: theme.surfaceOverlay,
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    alignItems:      'center',
    justifyContent:  'center',
  },
  gaugeVal: {
    color:       theme.textPrimary,
    fontWeight:  '700',
    flexShrink:  1,
    textAlign:   'center',
  },
  gaugeUnit: {
    fontWeight: '500',
    color:      theme.textMuted,
  },
  advBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: theme.space2,
    paddingVertical:   2,
    borderRadius:      theme.radiusSm,
    borderWidth:       1,
    borderColor:       theme.borderDefault,
  },
  advTxt: {
    color:      theme.accentBlue,
    fontWeight: '700',
  },
} as const
}
