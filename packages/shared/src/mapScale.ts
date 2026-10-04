/**
 * mapScale — scale bar + representative-fraction (1:N) maths shared by the
 * web and native map status pills. Pure functions of the camera centre
 * latitude and zoom, so both MapLibre builds produce identical labels.
 */

const EARTH_CIRCUMFERENCE_M = 40_075_016.686
/** MapLibre's world size at zoom 0, in CSS px / dp. */
const TILE_SIZE_PX = 512
/** One CSS px at the CSS reference 96 dpi, in metres. */
const CSS_PX_M = 0.0254 / 96
const M_PER_NM = 1852

export interface MapScale {
  /** Bar length in px/dp for the given maximum bar width. */
  barPx: number
  /** e.g. "5 NM", "2 km", "500 m". */
  label: string
  /** e.g. "1:250k". */
  ratio: string
}

/** Largest 1/2/5 × 10^n value ≤ v. */
function niceFloor(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const d = v / p
  return (d >= 5 ? 5 : d >= 2 ? 2 : 1) * p
}

export function formatScaleRatio(r: number): string {
  if (r >= 1e6) return `1:${(r / 1e6).toFixed(r >= 1e7 ? 0 : 1)}M`
  if (r >= 1e3) return `1:${Math.round(r / 1e3)}k`
  return `1:${Math.round(r)}`
}

/** Ground resolution in metres per px at a latitude/zoom (512 px tiles). */
export function metresPerPx(lat: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE_PX * Math.pow(2, zoom))
}

export function computeMapScale(lat: number, zoom: number, nm: boolean, maxBarPx: number): MapScale {
  const mPerPx = metresPerPx(lat, zoom)
  const unitM = nm ? M_PER_NM : 1000
  const maxUnits = (mPerPx * maxBarPx) / unitM
  let value: number, unit: string, valueM: number
  if (!nm && maxUnits < 1) {
    // Sub-kilometre: fall back to metres.
    value = niceFloor(mPerPx * maxBarPx); unit = 'm'; valueM = value
  } else {
    value = niceFloor(maxUnits); unit = nm ? 'NM' : 'km'; valueM = value * unitM
  }
  return {
    barPx: Math.max(1, Math.round(valueM / mPerPx)),
    label: `${value} ${unit}`,
    ratio: formatScaleRatio(mPerPx / CSS_PX_M),
  }
}
