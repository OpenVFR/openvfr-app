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
