/**
 * WindGauges — native port of web's WindGauges.tsx (graphical
 * wind-direction/runway compass + wind-speed dial), built with
 * react-native-svg since native has no DOM/CSS. Geometry, angle math, and
 * tone-driven colouring are identical to the web version -- only the
 * rendering primitives differ (Svg/Circle/Line/Text/Path/Polygon instead of
 * <svg>/CSS classes). See web's WindGauges.tsx doc comment re: this being
 * an own from-scratch SVG implementation, not a copy of any one site's
 * asset (AGENTS.md).
 *
 * Pure presentational -- all inputs are already-decoded values, no fetching.
 */

import Svg, { Circle, Line, Text as SvgText, Path, Polygon, Rect, G } from 'react-native-svg'
import { View, Text } from 'react-native'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import type { ParsedWind } from '@open-vfr/shared/fetchWx'

// ── Geometry helpers (identical to web's WindGauges.tsx) ──────────────────
function pt(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

export interface RunwayHeading {
  /** e.g. "12" / "30" */
  designators: [string, string]
  /** Magnetic bearing of designators[0], degrees. designators[1] is +180°. */
  headingDeg: number
}

type Tone = 'ok' | 'warn' | 'danger'

function toneColor(tone: Tone): string {
  if (tone === 'danger') return theme.statusDanger
  if (tone === 'warn') return theme.statusWarn
  return theme.accentGreen
}

interface CompassProps {
  wind: ParsedWind | null
  runway: RunwayHeading | null
  tone: Tone
  favoredEndDesignator?: string | null
}

const CX = 50
const CY = 50
const R_DIAL = 42
const R_TICK_OUT = 42
const R_TICK_IN = 37
const R_LABEL = 31
const R_RWY = 33
// Runway strip footprint, drawn as an actual rounded rectangle rather than
// a bare line -- matches web's WindGauges.tsx (see its runway block for
// the full rationale).
const RWY_LEN = 2 * R_RWY
const RWY_WIDTH = 9
// Designator labels sit INSIDE the strip near each end (like a real runway's
// painted threshold numbers), not out past it -- far enough in from the tip
// that the text box fits fully within RWY_WIDTH without poking past the
// dial's own rim (R_DIAL), which R_RWY+7 previously did.
const RWY_LABEL_R = R_RWY - 7

export function WindCompassGauge({ wind, runway, tone, favoredEndDesignator }: CompassProps) {
  const styles = useThemedStyles(makeStyles)
  const ticks = []
  for (let a = 0; a < 360; a += 30) {
    const p1 = pt(CX, CY, R_TICK_OUT, a)
    const p2 = pt(CX, CY, R_TICK_IN, a)
    ticks.push(<Line key={a} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={theme.textMuted} strokeWidth={1.3} />)
  }
  const cardinals: [string, number][] = [['N', 0], ['E', 90], ['S', 180], ['W', 270]]

  const showArrow = !!(wind && !wind.calm && !wind.variable && wind.dirDeg != null)
  const arrowFrom = showArrow ? pt(CX, CY, R_DIAL - 3, wind!.dirDeg!) : null
  const arrowTo   = showArrow ? pt(CX, CY, 9, wind!.dirDeg!) : null
  const arrowColor = toneColor(tone)

  // Runway designator label positions -- [0] sits at the reciprocal of
  // headingDeg (its own geographic position, see the runway block's doc
  // comment below), [1] at headingDeg itself.
  const rwyLabel0Pos = runway ? pt(CX, CY, RWY_LABEL_R, runway.headingDeg + 180) : null
  const rwyLabel1Pos = runway ? pt(CX, CY, RWY_LABEL_R, runway.headingDeg) : null

  return (
    <View style={styles.compassWrap}>
      <Svg viewBox="0 0 100 100" style={styles.compassSvg}>
        <Circle cx={CX} cy={CY} r={R_DIAL} fill={theme.surfaceHover} stroke={theme.textMuted} strokeWidth={1.5} />
        {ticks}
        {cardinals.map(([label, a]) => {
          const p = pt(CX, CY, R_LABEL, a)
          return (
            <SvgText key={label} x={p.x} y={p.y} fontSize={9} fontWeight="800" fill={theme.textSecondary} textAnchor="middle" alignmentBaseline="middle">
              {label}
            </SvgText>
          )
        })}

        {/* Runway -- drawn as an actual strip (filled rounded rectangle +
            dashed centerline), not just a bare line, matching web's
            WindGauges.tsx (see there for why designators[0] renders at
            headingDeg+180, its own geographic position, and
            designators[1] at headingDeg itself). */}
        {runway && (
          <>
            {/* The rect/centerline are drawn horizontal (pointing along
                compass bearing 90°/270°, i.e. east-west) before any
                rotation -- unlike pt() (which bakes in a -90° offset so
                angleDeg=0 means "up"/north), a plain SVG rotate() has no such
                offset, so headingDeg itself would over-rotate by 90°
                (leaving the strip 90° off from its own designator labels
                below, which DO use pt()). Subtracting 90 here aligns it. */}
            <G transform={`rotate(${runway.headingDeg - 90} ${CX} ${CY})`}>
              <Rect
                x={CX - RWY_LEN / 2} y={CY - RWY_WIDTH / 2}
                width={RWY_LEN} height={RWY_WIDTH} rx={1.5}
                fill="#454b57" stroke="#23262e" strokeWidth={0.6}
              />
              <Line
                x1={CX - RWY_LEN / 2 + 4} y1={CY}
                x2={CX + RWY_LEN / 2 - 4} y2={CY}
                stroke={theme.textPrimary} strokeWidth={0.8} strokeDasharray="2.4 2" strokeLinecap="round"
              />
            </G>
            {/* Rotated to match each designator's OWN landing/approach
                heading -- i.e. exactly as it's painted on a real runway,
                upright to a pilot flying that heading toward it (a
                north-up viewer sees e.g. "18"'s digits upside-down, which
                is correct -- that's how it looks from directly overhead
                too). designators[0]'s own approach heading IS headingDeg
                itself (see this file's runway block doc comment --
                threshold[0]'s own field already means "the direction of
                travel using that runway"); designators[1]'s is the
                reciprocal. No -90° correction needed here (unlike the Rect
                above) -- SVG text is already "upright"/north at zero
                rotation, matching this file's angleDeg convention directly. */}
            <SvgText
              x={rwyLabel0Pos!.x} y={rwyLabel0Pos!.y}
              transform={`rotate(${runway.headingDeg} ${rwyLabel0Pos!.x} ${rwyLabel0Pos!.y})`}
              fontSize={favoredEndDesignator === runway.designators[0] ? 8 : 7}
              fontWeight="800"
              fill={favoredEndDesignator === runway.designators[0] ? theme.accentGreen : theme.textPrimary}
              textAnchor="middle" alignmentBaseline="middle"
            >
              {runway.designators[0]}
            </SvgText>
            <SvgText
              x={rwyLabel1Pos!.x} y={rwyLabel1Pos!.y}
              transform={`rotate(${runway.headingDeg + 180} ${rwyLabel1Pos!.x} ${rwyLabel1Pos!.y})`}
              fontSize={favoredEndDesignator === runway.designators[1] ? 8 : 7}
              fontWeight="800"
              fill={favoredEndDesignator === runway.designators[1] ? theme.accentGreen : theme.textPrimary}
              textAnchor="middle" alignmentBaseline="middle"
            >
              {runway.designators[1]}
            </SvgText>
          </>
        )}

        {showArrow && arrowFrom && arrowTo && (
          <G>
            <Line x1={arrowFrom.x} y1={arrowFrom.y} x2={arrowTo.x} y2={arrowTo.y} stroke={arrowColor} strokeWidth={3.5} strokeLinecap="round" />
            <Polygon
              points="0,-6 7,6 -7,6"
              fill={arrowColor}
              transform={`translate(${arrowTo.x},${arrowTo.y}) rotate(${wind!.dirDeg! + 180})`}
            />
          </G>
        )}

      </Svg>
      {/* Direction only -- speed lives under the speed dial (WindSpeedGauge)
          so the two captions don't both repeat the same number. Never a
          word in its place ("CALM"/"VRB") -- when there's no direction to
          show (calm/variable/no data), this is simply blank; the arrow's
          own absence already communicates that. */}
      <Text style={styles.caption} allowFontScaling={false}>
        {wind && !wind.calm && !wind.variable && wind.dirDeg != null
          ? `${String(wind.dirDeg).padStart(3, '0')}°`
          : ''}
      </Text>
    </View>
  )
}

// ── Speed dial ─────────────────────────────────────────────────────────────

interface SpeedDialProps {
  wind: ParsedWind | null
  tone: Tone
  maxKt?: number
}

const SWEEP_START = -135
const SWEEP_DEG = 270

function speedAngle(speedKt: number, maxKt: number): number {
  const frac = Math.max(0, Math.min(1, speedKt / maxKt))
  return SWEEP_START + frac * SWEEP_DEG
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p0 = pt(cx, cy, r, a0)
  const p1 = pt(cx, cy, r, a1)
  const large = a1 - a0 > 180 ? 1 : 0
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y}`
}

export function WindSpeedGauge({ wind, tone, maxKt = 45 }: SpeedDialProps) {
  const styles = useThemedStyles(makeStyles)
  const speedKt = wind && !wind.calm ? wind.speedKt : 0
  const gustKt  = wind?.gustKt ?? null
  const needleAngle = speedAngle(speedKt, maxKt)
  const ticks = [0, 10, 20, 30, 40].filter((v) => v <= maxKt)
  const progressColor = toneColor(tone)

  return (
    <View style={styles.compassWrap}>
      <Svg viewBox="0 0 100 100" style={styles.compassSvg}>
        <Path d={arcPath(CX, CY, R_DIAL, SWEEP_START, SWEEP_START + SWEEP_DEG)} stroke={theme.borderStrong} strokeWidth={7} strokeLinecap="round" fill="none" />
        <Path d={arcPath(CX, CY, R_DIAL, SWEEP_START, needleAngle)} stroke={progressColor} strokeWidth={7} strokeLinecap="round" fill="none" />
        {ticks.map((v) => {
          const a = speedAngle(v, maxKt)
          const p = pt(CX, CY, R_LABEL, a)
          return (
            <SvgText key={v} x={p.x} y={p.y} fontSize={9} fontWeight="700" fill={theme.textSecondary} textAnchor="middle" alignmentBaseline="middle">
              {v}
            </SvgText>
          )
        })}
        <Line
          x1={CX} y1={CY}
          x2={pt(CX, CY, R_DIAL - 8, needleAngle).x}
          y2={pt(CX, CY, R_DIAL - 8, needleAngle).y}
          stroke={theme.textPrimary}
          strokeWidth={2}
          strokeLinecap="round"
        />
        <Circle cx={CX} cy={CY} r={3} fill={theme.textPrimary} />
      </Svg>
      <Text style={styles.caption} allowFontScaling={false}>
        {speedKt}kt{gustKt ? ` gust ${gustKt}kt` : ''}
      </Text>
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  compassWrap: {
    alignItems: 'center' as const,
    gap: 4,
  },
  compassSvg: {
    // Fixed viewBox="0 0 100 100" internally -- scaling width/height scales
    // every SVG-space value (ticks, arrow, runway strip, in-SVG fontSize=)
    // proportionally for free. Only the outer pixel footprint needs scaling.
    width: theme.scale(160),
    height: theme.scale(160),
  },
  caption: {
    fontSize: theme.textMd,
    fontWeight: '700' as const,
    color: theme.textPrimary,
    textAlign: 'center' as const,
  },
 }
}
