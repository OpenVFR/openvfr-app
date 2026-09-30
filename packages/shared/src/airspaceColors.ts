/**
 * Canonical airspace colour palette — single source of truth for web and native.
 *
 * Web (MapLibre GL JS / map-style.ts) and native (@maplibre/maplibre-react-native)
 * both import from here so the map looks identical on both platforms.
 *
 * Class C has a CTR/TMA sub-distinction. The web uses MapLibre match expressions
 * for this; native builds separate expression arrays using the same raw values.
 *
 * All values are rgba() strings — understood by both MapLibre GL JS and GL Native.
 */

export const AIRSPACE_COLORS = {
  /** Class C — CTR (Control Zone, stronger) */
  cCtrFill:    'rgba(180, 50, 180, 0.12)',
  cCtrBorder:  'rgba(180, 50, 180, 0.90)',

  /** Class C — TMA (Terminal Manoeuvring Area, lighter) */
  cTmaFill:    'rgba(30, 90, 200, 0.07)',
  /** Map fill for TMA/CTA: practically invisible. Sectors overlap heavily, so
   *  their fills stack into a blue tint over most of the map; the border and
   *  inset band carry the shape instead. Not fully transparent so the polygon
   *  stays hit-testable for tap-to-inspect. (cTmaFill is still used by the
   *  vertical profile.) */
  cTmaMapFill: 'rgba(30, 90, 200, 0.01)',
  cTmaBorder:  'rgba(30, 90, 200, 0.70)',

  /** Class D */
  dFill:       'rgba(50, 130, 220, 0.06)',
  /** Map fill for D: near-clear, same reasoning as cTmaMapFill. */
  dMapFill:    'rgba(50, 130, 220, 0.01)',
  dBorder:     'rgba(50, 130, 220, 0.70)',

  /** Class A (not for VFR): dark magenta, darker than the class C CTR magenta. */
  aBorder:     'rgba(120, 20, 110, 0.90)',
  aFill:       'rgba(120, 20, 110, 0.10)',
  /** Class B/C/D share the blue of cTmaBorder. Class E: same blue, drawn as a
   *  thick line only. Class F (advisory): lighter, thin line. */
  eBorder:     'rgba(30, 90, 200, 0.85)',
  eFill:       'rgba(30, 90, 200, 0.05)',
  fBorder:     'rgba(90, 150, 220, 0.75)',
  fFill:       'rgba(90, 150, 220, 0.05)',

  /** Class G — RMZ / ATZ zones */
  gFill:       'rgba(120, 120, 120, 0.12)',
  gBorder:     'rgba(120, 120, 120, 0.65)',

  /** Restricted (R), danger (D) and prohibited (P) areas: red. */
  rFill:       'rgba(215, 30, 40, 0.14)',
  rBorder:     'rgba(215, 30, 40, 0.85)',

  /** TRA (Temporary Reserved Area) — lighter variant of restricted */
  traFill:     'rgba(220, 100, 0, 0.07)',
  traBorder:   'rgba(220, 100, 0, 0.55)',

  /** Glider activity area */
  gldrFill:    'rgba(0, 160, 80, 0.07)',
  gldrBorder:  'rgba(0, 160, 80, 0.70)',

  /** Model flying area */
  modelFill:   'rgba(200, 150, 0, 0.07)',
  modelBorder: 'rgba(200, 150, 0, 0.70)',

  /** Transparent — used as MapLibre expression fallback */
  transparent: 'rgba(0, 0, 0, 0)',
} as const

export type AirspaceColorKey = keyof typeof AIRSPACE_COLORS

/**
 * The data's `class` bucket 'D' mixes ICAO Class D (type CTR/TMA) with danger
 * areas (type 'D'). Danger areas belong in the red restricted bucket, so every
 * consumer that keys on class should read it through this helper.
 */
export function airspaceDisplayClass(cls: string, type: string): string {
  return cls === 'D' && type === 'D' ? 'R' : cls
}

/** ICAO classes that describe controlled/advisory airspace drawn as CTR or TMA/CTA. Class G is deliberately absent: it is the default airspace everywhere. */
export const CONTROLLED_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F'] as const
export type ControlledClass = (typeof CONTROLLED_CLASSES)[number]

/** Types that are structural zones inside uncontrolled airspace or not airspace to draw (RMZ/ATZ/TMZ get their own style, FIR/UIR none). */
export const ZONE_TYPES = ['RMZ', 'ATZ', 'TMZ'] as const

/** Same colour with a different alpha, for rgba() palette strings. */
export function withAlphaColor(color: string, alpha: number): string {
  return color.replace(/rgba?\(([^)]*)\)/, (_m, inner: string) => {
    const [r, g, b] = inner.split(',').map((v) => v.trim())
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  })
}

/**
 * Border/fill colours of a controlled-airspace polygon by ICAO class and type.
 * The colour follows what the pilot must do: A (not for VFR) dark magenta;
 * B/C/D (clearance needed) blue with an inset band; E (no clearance) the same
 * blue as a thicker line only, no band or fill; F (advisory) a thin lighter
 * line. `fill` is the profile/popup fill, `mapFill` the near-clear map fill
 * for TMA/CTA (their sectors overlap heavily) while CTRs keep `fill`.
 * `band` scales the inset band's opacity, `width` the border width.
 */
export type ControlledStyle = { border: string; fill: string; mapFill: string; band: number; width: number }
export function controlledStyle(cls: string, type: string): ControlledStyle {
  const A = AIRSPACE_COLORS
  const isCtr = type === 'CTR'
  const clear = (c: string) => withAlphaColor(c, 0.01)
  switch (cls) {
    case 'A': return { border: A.aBorder, fill: A.aFill, mapFill: isCtr ? A.aFill : clear(A.aBorder), band: 1, width: 1 }
    case 'B': return { border: A.cTmaBorder, fill: A.cTmaFill, mapFill: isCtr ? A.cTmaFill : A.cTmaMapFill, band: 1, width: 1 }
    case 'C': return isCtr
      ? { border: A.cCtrBorder, fill: A.cCtrFill, mapFill: A.cCtrFill, band: 1, width: 1 }
      : { border: A.cTmaBorder, fill: A.cTmaFill, mapFill: A.cTmaMapFill, band: 1, width: 1 }
    case 'D': return { border: A.cTmaBorder, fill: A.dFill, mapFill: isCtr ? A.dFill : A.dMapFill, band: 1, width: 1 }
    case 'E': return { border: A.eBorder, fill: A.eFill, mapFill: clear(A.eBorder), band: 0, width: 2 }
    case 'F': return { border: A.fBorder, fill: A.fFill, mapFill: clear(A.fBorder), band: 0, width: 0.7 }
    default:  return { border: A.gBorder, fill: A.gFill, mapFill: A.transparent, band: 0, width: 1 }
  }
}
