/**
 * radarStyle — look and symbol sizing of the Virtual Radar, shared by web
 * (VirtualRadar.tsx) and native (VerticalProfile.tsx) so the two charts keep
 * the same colours, symbol sizes and marker wording.
 */
import { formatAltitudeFt } from './profileChart'
import type { BoxRect } from './profileLabels'

/** Obstacle symbols are widened (not heightened: height is data) for legibility. */
export const OBSTACLE_X_SCALE = 1.6
/** Ground end (px) of an obstacle symbol drawn from `tipY`: the real ground, never below the plot.
 *  The symbol spans exactly tip to ground (height is data); an obstacle too short on this scale for
 *  a full shape (obstacleSymbol returns null) is drawn as the map pictogram instead. */
export const symbolGroundY = (_tipY: number, groundY: number, plotBottom: number) => Math.min(groundY, plotBottom)

/** Limiting obstacles closer than this (px) share a single label. */
export const LIMITING_LABEL_MERGE_PX = 160

/** Aerodrome / navaid / reporting-point symbols are drawn this much larger than their base size. */
export const POI_SCALE = 1.45
/** Centre (px) of a POI symbol: it stands on the ground line instead of being centred on it, where
 *  the ground fill would cover its lower half and the axis would cut it off. */
export const poiCenterY = (groundY: number, plotBottom: number) => Math.min(groundY - 7, plotBottom - 8)

/** Plot background, top → bottom. Mid-tone so red/steel obstacles and white clouds all contrast. */
export const SKY_TOP = '#2c4468'
export const SKY_BOTTOM = '#6b92b8'
export const PLAN_COLOR = '#e040fb'
export const MSA_COLOR = '#ffb454'
/** Light green: the ground's label colour (hover readout). */
export const GROUND_COLOR = '#e4f0b8'
/** Outline of the ground under the track: dark green, so it separates the ground from the sky and the
 *  corridor band without a bright seam. */
export const GROUND_OUTLINE = '#1f6b22'
/** Highest ground within the corridor either side of the track: a nearly opaque khaki band behind the ground,
 *  with a brown outline (no dashes), so the two layers read as two different things. */
export const CORRIDOR_FILL = 'rgba(201,177,96,0.88)'
export const CORRIDOR_OUTLINE = '#d08645'
export const DANGER_COLOR = 'rgba(239,68,68,0.95)'
/** Red text on the dark chart: DANGER_COLOR fails contrast, use a lighter tint. */
export const DANGER_TEXT = '#ff8f8f'
/** Amber label of a climb that ends below the level set for its leg. */
export const PHASE_SHORT_COLOR = '#ffc766'
/** Wind-aloft label colour (bright on any sky). */
export const WIND_LABEL_COLOR = '#eaf6ff'

/** Ground gradient by elevation: opaque, mid-tone, so the ground separates clearly from the sky. */
export const TERRAIN_COLOR_STOPS: { elev: number | 'top'; color: string }[] = [
  { elev: 'top', color: '#a39e96' },  // grey rock (peak / top of chart)
  { elev: 3000,  color: '#a8844f' },  // brown highland
  { elev: 1000,  color: '#8fa850' },  // mixed hill
  { elev: 300,   color: '#78b43e' },  // green lowland
  { elev: 50,    color: '#5fa63c' },  // coastal green
  { elev: 0,     color: '#3f86c8' },  // blue: sea level / water
]

/** Gradient offsets (%) of TERRAIN_COLOR_STOPS for a scale from yMin to yMax: a colour always means the same altitude. */
export function terrainGradientStops(yMin: number, yMax: number): { offset: number; color: string }[] {
  const span = Math.max(1, yMax - yMin)
  return TERRAIN_COLOR_STOPS.map(({ elev, color }) => ({
    offset: Math.max(0, Math.min(100, ((yMax - (elev === 'top' ? yMax : elev)) / span) * 100)),
    color,
  }))
}

/** Wording of a top-of-climb / top-of-descent marker. `setLevelFt` = the level the leg asked for,
 *  when the climb ends below it. */
export function phaseLabelText(kind: 'TOC' | 'TOD', altFt: number, setLevelFt?: number): string {
  if (kind === 'TOD') return 'TOD'
  return setLevelFt != null ? `TOC ${formatAltitudeFt(altFt)} (${formatAltitudeFt(setLevelFt)} set)` : `TOC ${formatAltitudeFt(altFt)}`
}

/**
 * A wind-aloft barb with its "dir/kt" label, kept clear of the airspace chips (and any other boxes):
 * label on the right, else on the left, else barb only; a barb that itself sits on a chip is dropped.
 * `labelW`: width of the label text (px); `gap`: barb centre to label start.
 */
export function windAloftFit(
  cx: number, cy: number, labelW: number, avoid: readonly BoxRect[], bounds: { left: number; right: number },
  gap = 12,
): { barb: boolean; label: 'right' | 'left' | null } {
  const hits = (b: BoxRect) => avoid.some((a) => b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top)
  const barb: BoxRect = { left: cx - 8, right: cx + 8, top: cy - 10, bottom: cy + 10 }
  if (hits(barb)) return { barb: false, label: null }
  const right: BoxRect = { left: cx + gap, right: cx + gap + labelW, top: cy - 8, bottom: cy + 8 }
  if (right.right <= bounds.right && !hits(right)) return { barb: true, label: 'right' }
  const left: BoxRect = { left: cx - gap - labelW, right: cx - gap, top: cy - 8, bottom: cy + 8 }
  if (left.left >= bounds.left && !hits(left)) return { barb: true, label: 'left' }
  return { barb: true, label: null }
}
