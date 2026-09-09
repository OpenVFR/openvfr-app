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
  cTmaBorder:  'rgba(30, 90, 200, 0.70)',

  /** Class D */
  dFill:       'rgba(50, 130, 220, 0.06)',
  dBorder:     'rgba(50, 130, 220, 0.70)',

  /** Class E */
  eFill:       'rgba(0, 160, 80, 0.15)',
  eBorder:     'rgba(0, 160, 80, 0.90)',

  /** Class G — RMZ / ATZ zones */
  gFill:       'rgba(120, 120, 120, 0.12)',
  gBorder:     'rgba(120, 120, 120, 0.65)',

  /** Restricted (R) */
  rFill:       'rgba(220, 100, 0, 0.14)',
  rBorder:     'rgba(220, 100, 0, 0.85)',

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
