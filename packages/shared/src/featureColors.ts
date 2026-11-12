/**
 * Feature colour palette — canonical colours for aviation map features.
 * Shared between web (map-style.ts) and native (AviationMap.tsx).
 *
 * Web uses canvas-drawn icons; native uses MapLibre circles/lines.
 * The brand colour for each feature type is the same on both platforms
 * even if the rendering primitive differs.
 */

// ── Aerodromes ───────────────────────────────────────────────────────────────
export const AERODROME_COLORS = {
  /** Standard aerodrome / airfield */
  default: '#3b82f6',   // blue
  /** Helipad */
  helipad: '#a855f7',   // purple
  /** Text label */
  label:   '#1a3a8f',   // dark blue (matches web symbol label)
  halo:    '#ffffff',
  /** ATC status ring (towered airports only) — AIP-schedule-derived,
   *  see @open-vfr/shared/atcStatus. Never NOTAM-driven. */
  atcOpen:    '#22c55e',  // green
  atcClosed:  '#ef4444',  // red
  atcUnknown: '#9ca3af',  // grey — towered but no usable schedule data
} as const

// ── Navaids ──────────────────────────────────────────────────────────────────
export const NAVAID_COLORS = {
  /** VOR / VOR-DME / VORTAC */
  vor:     '#6366f1',   // indigo
  vorText: '#3b2fa0',   // darker indigo for text (web symbol label)
  /** NDB */
  ndb:     '#f97316',   // orange
  ndbText: '#8a3800',   // darker orange for text (web symbol label)
  halo:    '#ffffff',
} as const

// ── Waypoints ────────────────────────────────────────────────────────────────
export const WAYPOINT_COLORS = {
  /** MRP — Mandatory Reporting Point */
  mrp:     '#06b6d4',   // cyan
  mrpText: '#085f45',   // dark teal for text (web symbol label)
  /** RP — Reporting Point */
  rp:      '#0b6e55',   // dark teal
  rpText:  '#0b6e55',
  halo:    '#ffffff',
} as const

// ── Obstacles ────────────────────────────────────────────────────────────────
export const OBSTACLE_COLORS = {
  windTurbine: '#b36500',
  tower:       '#a80000',
  chimney:     '#5c1f1f',
  building:    '#6b7280',
  waterTower:  '#00695c',
  default:     '#555555',
  halo:        '#ffffff',
  /** Circle fill used on native (no icon support) */
  circleFill:  '#aaaaaa',
  circleStroke: 'rgba(0,0,0,0.5)',
} as const

// ── Runways ───────────────────────────────────────────────────────────────────
export const RUNWAY_COLORS = {
  /** Asphalt surface */
  asphalt: '#c8cdd8',
  /** Concrete surface */
  concrete: '#d0d4dc',
  /** Grass / other surface */
  grass: '#c0d0b8',
  /** Runway outline / border */
  outline: '#6a7080',
} as const

// ── Clouds (vertical profile) ─────────────────────────────────────────────────
export const CLOUD_COLORS = {
  /** Glyph fill gradient, top → bottom (lit tops, shaded base) */
  fillTop:     '#f1f5f9',
  fillBottom:  '#94a3b8',
  fillTopOpacity:    0.90,
  fillBottomOpacity: 0.65,
  stroke:      'rgba(255,255,255,0.85)',
  label:       'rgba(226,232,240,0.95)',
  /** Convective cloud: darker body, warning outline + label */
  convectiveFillTop:    '#cbd5e1',
  convectiveFillBottom: '#475569',
  tcu:         'rgba(250,204,21,0.95)',   // amber — towering cumulus
  cb:          'rgba(239,68,68,0.95)',    // red — cumulonimbus
} as const

// ── Curated aerodrome details (circuits, noise areas, ...) ─────────────────────
import type { CircuitGroup, DetailKind } from './aerodromeDetails'

/** One colour per aircraft group's circuit (a club map draws them in different colours too). */
export const CIRCUIT_GROUP_COLOR: Record<CircuitGroup, string> = {
  powered: '#38bdf8',
  glider: '#22c55e',
  ultralight: '#f97316',
  helicopter: '#a855f7',
  gyro: '#eab308',
}

/** One colour per kind of local area (map fill/outline, list badges). */
export const DETAIL_KIND_COLOR: Record<DetailKind, string> = {
  noise_sensitive: '#f59e0b',
  avoid_area: '#ef4444',
  glider_area: '#22c55e',
  parachute_area: '#a855f7',
  model_area: '#14b8a6',
  circuit_leg: '#38bdf8',
  reporting_point: '#a3e635',
  holding: '#0ca678',
  taxiway: '#94a3b8',
  parking: '#94a3b8',
  other: '#cbd5e1',
}

/** The focused-circuit highlight (the powered-aircraft circuit colour). */
export const CIRCUIT_FOCUS_COLOR = CIRCUIT_GROUP_COLOR.powered
