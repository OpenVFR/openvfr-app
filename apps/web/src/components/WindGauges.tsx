/**
 * WindGauges — graphical wind-direction/runway compass + wind-speed dial.
 *
 * Visual parity target: public METAR/TAF reference sites show two round
 * gauges (a compass with the active runway drawn across it, and a speed
 * dial) rather than plain text. This is our own from-scratch SVG
 * implementation of the same idea, not a pixel clone (see AGENTS.md — never
 * describe/copy a competing product's own asset, only the general
 * technique: a compass rose + runway bar + a speed dial are generic
 * aviation-weather UI conventions, not any one site's IP).
 *
 * Pure presentational — all inputs are already-decoded values, no fetching.
 */

import css from './WindGauges.module.css'
import type { ParsedWind } from '@open-vfr/shared/fetchWx'

// ── Geometry helpers ──────────────────────────────────────────────────────────
// angleDeg: compass heading, 0 = up (North), clockwise positive — matches
// true/magnetic bearing convention used everywhere else in this app.
function pt(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

// ── Compass (wind direction + runway orientation) ─────────────────────────────

export interface RunwayHeading {
  /** e.g. "12" / "30" */
  designators: [string, string]
  /** Magnetic bearing of designators[0], degrees. designators[1] is +180°. */
  headingDeg: number
}

interface CompassProps {
  wind: ParsedWind | null
  runway: RunwayHeading | null
  /** 'ok' | 'warn' | 'danger' — colours the wind arrow, matches the Wind tile's own tone. */
  tone: 'ok' | 'warn' | 'danger'
  /** Which end of `runway` has the best headwind, if known — bolded/
   *  greened on the dial itself so the recommendation is visible without
   *  reading the picker's tooltip or the Info tab's separate wind row. */
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
// a bare line (see WindCompassGauge's runway block below).
const RWY_LEN = 2 * R_RWY
const RWY_WIDTH = 9
// Designator labels sit INSIDE the strip near each end (like a real runway's
// painted threshold numbers), not out past it -- far enough in from the tip
// that the text box fits fully within RWY_WIDTH without poking past the
// dial's own rim (R_DIAL), which R_RWY+7 previously did.
const RWY_LABEL_R = R_RWY - 7

export function WindCompassGauge({ wind, runway, tone, favoredEndDesignator }: CompassProps) {
  const ticks = []
  for (let a = 0; a < 360; a += 30) {
    const p1 = pt(CX, CY, R_TICK_OUT, a)
    const p2 = pt(CX, CY, R_TICK_IN, a)
    ticks.push(<line key={a} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className={css.tick} />)
  }
  const cardinals: [string, number][] = [['N', 0], ['E', 90], ['S', 180], ['W', 270]]

  const showArrow = wind && !wind.calm && !wind.variable && wind.dirDeg != null
  const arrowFrom = showArrow ? pt(CX, CY, R_DIAL - 3, wind!.dirDeg!) : null
  const arrowTo   = showArrow ? pt(CX, CY, 9, wind!.dirDeg!) : null

  // Runway designator label positions -- [0] sits at the reciprocal of
  // headingDeg (its own geographic position, see the runway block's doc
  // comment below), [1] at headingDeg itself.
  const rwyLabel0Pos = runway ? pt(CX, CY, RWY_LABEL_R, runway.headingDeg + 180) : null
  const rwyLabel1Pos = runway ? pt(CX, CY, RWY_LABEL_R, runway.headingDeg) : null

  return (
    <div className={css.compassWrap}>
      <svg viewBox="0 0 100 100" className={css.compassSvg}>
        <circle cx={CX} cy={CY} r={R_DIAL} className={css.dialBg} />
        {ticks}
        {cardinals.map(([label, a]) => {
          const p = pt(CX, CY, R_LABEL, a)
          return (
            <text key={label} x={p.x} y={p.y} className={css.cardinalLabel} textAnchor="middle" dominantBaseline="middle">
              {label}
            </text>
          )
        })}

        {/* Runway -- drawn as an actual strip (filled rounded rectangle +
            dashed centerline + threshold caps), not just a bare line, so it
            reads as a runway at a glance the way a public METAR/TAF site's
            own runway diagram does (own from-scratch shape, not a copy --
            see file doc comment / AGENTS.md). headingDeg is threshold[0]'s
            OWN bearing field, which per the data's convention (see
            MapView.tsx's buildCentrelines comment and
            @open-vfr/shared/runwayWind) points AWAY from threshold[0]
            itself, along the strip, toward the OTHER end -- e.g. threshold
            "12"'s own field is ~120-129° (the direction of travel USING
            runway 12), not where the 12 end physically sits. So threshold
            [0]'s own label goes at the RECIPROCAL of headingDeg (that's
            its own geographic position), and designators[1] goes at
            headingDeg itself. Placing them the other way round (as an
            earlier version of this file did) draws "12" where "30"
            actually is. */}
        {runway && (
          <>
            {/* The rect/centerline are drawn horizontal (pointing along
                compass bearing 90°/270°, i.e. east-west) before any
                rotation -- unlike pt() (which bakes in a -90° offset so
                angleDeg=0 means "up"/north), a plain SVG rotate() has no such
                offset, so headingDeg itself would over-rotate by 90°
                (leaving the strip 90° off from its own designator labels
                below, which DO use pt()). Subtracting 90 here aligns it. */}
            <g transform={`rotate(${runway.headingDeg - 90} ${CX} ${CY})`}>
              <rect
                x={CX - RWY_LEN / 2} y={CY - RWY_WIDTH / 2}
                width={RWY_LEN} height={RWY_WIDTH} rx={1.5}
                className={css.rwyBody}
              />
              <line
                x1={CX - RWY_LEN / 2 + 4} y1={CY}
                x2={CX + RWY_LEN / 2 - 4} y2={CY}
                className={css.rwyCenterline}
              />
            </g>
            {/* Rotated to match each designator's OWN landing/approach
                heading -- i.e. exactly as it's painted on a real runway,
                upright to a pilot flying that heading toward it (a
                north-up viewer sees e.g. "18"'s digits upside-down, which
                is correct -- that's how it looks from directly overhead
                too). designators[0]'s own approach heading IS headingDeg
                itself (see the doc comment above -- threshold[0]'s own
                field already means "the direction of travel using that
                runway"); designators[1]'s is the reciprocal. No -90°
                correction needed here (unlike the rect above) -- SVG text
                is already "upright"/north at zero rotation, matching this
                file's angleDeg convention directly. */}
            <text
              x={rwyLabel0Pos!.x} y={rwyLabel0Pos!.y}
              transform={`rotate(${runway.headingDeg} ${rwyLabel0Pos!.x} ${rwyLabel0Pos!.y})`}
              className={`${css.rwyLabel} ${favoredEndDesignator === runway.designators[0] ? css.rwyLabelFavored : ''}`}
              textAnchor="middle" dominantBaseline="middle"
            >
              {runway.designators[0]}
            </text>
            <text
              x={rwyLabel1Pos!.x} y={rwyLabel1Pos!.y}
              transform={`rotate(${runway.headingDeg + 180} ${rwyLabel1Pos!.x} ${rwyLabel1Pos!.y})`}
              className={`${css.rwyLabel} ${favoredEndDesignator === runway.designators[1] ? css.rwyLabelFavored : ''}`}
              textAnchor="middle" dominantBaseline="middle"
            >
              {runway.designators[1]}
            </text>
          </>
        )}

        {/* Wind arrow — shaft points from the heading wind is blowing FROM
            in toward the field, arrowhead at the inner end. */}
        {showArrow && arrowFrom && arrowTo && (
          <g className={`${css.windArrowGroup} ${css[`windArrow${tone}`]}`}>
            <line x1={arrowFrom.x} y1={arrowFrom.y} x2={arrowTo.x} y2={arrowTo.y} className={css.windShaft} />
            <polygon
              points="0,-4 5,4 -5,4"
              transform={`translate(${arrowTo.x},${arrowTo.y}) rotate(${wind!.dirDeg! + 180})`}
              className={css.windHead}
            />
          </g>
        )}

      </svg>
      {/* Direction only -- speed lives under the speed dial (WindSpeedGauge)
          so the two captions don't both repeat the same number. Never a
          word in its place ("CALM"/"VRB") -- when there's no direction to
          show (calm/variable/no data), this is simply blank; the arrow's
          own absence already communicates that. */}
      <div className={css.compassCaption}>
        {wind && !wind.calm && !wind.variable && wind.dirDeg != null
          ? `${String(wind.dirDeg).padStart(3, '0')}°`
          : ''}
      </div>
    </div>
  )
}

// ── Speed dial ─────────────────────────────────────────────────────────────────

interface SpeedDialProps {
  wind: ParsedWind | null
  tone: 'ok' | 'warn' | 'danger'
  /** Dial full-scale, knots. */
  maxKt?: number
}

// 270° sweep, starting at -135° (lower-left) through 0° (top) to +135°
// (lower-right) — standard automotive-gauge layout, clockwise.
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
  const speedKt = wind && !wind.calm ? wind.speedKt : 0
  const gustKt  = wind?.gustKt ?? null
  const needleAngle = speedAngle(speedKt, maxKt)
  const ticks = [0, 10, 20, 30, 40].filter((v) => v <= maxKt)

  return (
    <div className={css.dialWrap}>
      <svg viewBox="0 0 100 100" className={css.compassSvg}>
        <path d={arcPath(CX, CY, R_DIAL, SWEEP_START, SWEEP_START + SWEEP_DEG)} className={css.speedTrack} />
        <path d={arcPath(CX, CY, R_DIAL, SWEEP_START, needleAngle)} className={`${css.speedProgress} ${css[`speedProgress${tone}`]}`} />
        {ticks.map((v) => {
          const a = speedAngle(v, maxKt)
          const p = pt(CX, CY, R_LABEL, a)
          return (
            <text key={v} x={p.x} y={p.y} className={css.speedTickLabel} textAnchor="middle" dominantBaseline="middle">
              {v}
            </text>
          )
        })}
        {/* Needle */}
        <line
          x1={CX} y1={CY}
          x2={pt(CX, CY, R_DIAL - 8, needleAngle).x}
          y2={pt(CX, CY, R_DIAL - 8, needleAngle).y}
          className={css.needle}
        />
        <circle cx={CX} cy={CY} r={3} className={css.needleHub} />
      </svg>
      <div className={css.compassCaption}>
        {speedKt}kt{gustKt ? ` gust ${gustKt}kt` : ''}
      </div>
    </div>
  )
}
