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

import React, { useCallback, useEffect, useRef } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
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

function StepperButton({ onPressIn, onPressOut, children }: {
  onPressIn:  () => void
  onPressOut: () => void
  children:   React.ReactNode
}) {
  const styles = useThemedStyles(makeStyles)
  return (
    <TouchableOpacity
      style={styles.stepBtn}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      activeOpacity={0.6}
    >
      {children}
    </TouchableOpacity>
  )
}

export function SimControlPanel({ speedKts, altFt, trackDeg, onAdjustHeading, onAdjustSpeed, onAdjustAlt, onAdvance, onStop }: Props) {
  const styles = useThemedStyles(makeStyles)
  const hdg   = useHoldRepeat(onAdjustHeading)
  const speed = useHoldRepeat(onAdjustSpeed)
  const alt   = useHoldRepeat(onAdjustAlt)

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Ionicons name="game-controller-outline" size={14} color={theme.accentBlue} />
        <Text style={styles.headerTxt}>SIMULATION</Text>
        <TouchableOpacity onPress={onStop} hitSlop={8} testID="sim-stop">
          <Ionicons name="close-circle" size={18} color={theme.statusDanger} />
        </TouchableOpacity>
      </View>

      <View style={styles.row}>
        <View style={styles.gauge}>
          <Text style={styles.gaugeLabel}>HDG</Text>
          <View style={styles.stepperRow}>
            <StepperButton onPressIn={() => hdg.onPressIn(-1)} onPressOut={hdg.onPressOut}>
              <Ionicons name="remove" size={16} color={theme.textPrimary} />
            </StepperButton>
            <Text style={styles.gaugeVal}>{Math.round(trackDeg).toString().padStart(3, '0')}<Text style={styles.gaugeUnit}>°</Text></Text>
            <StepperButton onPressIn={() => hdg.onPressIn(1)} onPressOut={hdg.onPressOut}>
              <Ionicons name="add" size={16} color={theme.textPrimary} />
            </StepperButton>
          </View>
        </View>

        <View style={styles.gauge}>
          <Text style={styles.gaugeLabel}>SPEED</Text>
          <View style={styles.stepperRow}>
            <StepperButton onPressIn={() => speed.onPressIn(-1)} onPressOut={speed.onPressOut}>
              <Ionicons name="remove" size={16} color={theme.textPrimary} />
            </StepperButton>
            <Text style={styles.gaugeVal}>{Math.round(speedKts)}<Text style={styles.gaugeUnit}> kt</Text></Text>
            <StepperButton onPressIn={() => speed.onPressIn(1)} onPressOut={speed.onPressOut}>
              <Ionicons name="add" size={16} color={theme.textPrimary} />
            </StepperButton>
          </View>
        </View>

        <View style={styles.gauge}>
          <Text style={styles.gaugeLabel}>ALT</Text>
          <View style={styles.stepperRow}>
            <StepperButton onPressIn={() => alt.onPressIn(-1)} onPressOut={alt.onPressOut}>
              <Ionicons name="remove" size={16} color={theme.textPrimary} />
            </StepperButton>
            <Text style={styles.gaugeVal}>{Math.round(altFt)}<Text style={styles.gaugeUnit}> ft</Text></Text>
            <StepperButton onPressIn={() => alt.onPressIn(1)} onPressOut={alt.onPressOut}>
              <Ionicons name="add" size={16} color={theme.textPrimary} />
            </StepperButton>
          </View>
        </View>

        <TouchableOpacity style={styles.advBtn} onPress={onAdvance}>
          <Ionicons name="play-skip-forward-outline" size={14} color={theme.accentBlue} />
          <Text style={styles.advTxt}>1NM</Text>
        </TouchableOpacity>
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
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  gaugeLabel: {
    color:      theme.textMuted,
    fontSize:   9,
    fontWeight: '600',
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           theme.space1,
  },
  stepBtn: {
    width:           26,
    height:          26,
    borderRadius:    theme.radiusSm,
    backgroundColor: theme.surfaceOverlay,
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    alignItems:      'center',
    justifyContent:  'center',
  },
  gaugeVal: {
    color:       theme.textPrimary,
    fontSize:    theme.textMd,
    fontWeight:  '700',
    minWidth:    52,
    textAlign:   'center',
  },
  gaugeUnit: {
    fontSize:   10,
    fontWeight: '500',
    color:      theme.textMuted,
  },
  advBtn: {
    alignItems: 'center',
    paddingHorizontal: theme.space2,
    paddingVertical:   theme.space1,
    borderRadius:      theme.radiusSm,
    borderWidth:       1,
    borderColor:       theme.borderDefault,
  },
  advTxt: {
    color:      theme.accentBlue,
    fontSize:   9,
    fontWeight: '700',
    marginTop:  1,
  },
} as const
}
