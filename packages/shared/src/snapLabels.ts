/**
 * Snap-picker display labels — shared between web (MapView.tsx/SnapPicker.tsx)
 * and native (AviationMap.tsx/SnapPicker.tsx) so both apps use identical
 * wording for the same concepts instead of drifting independently.
 */

/** Label for the always-available "use the exact point you dropped/tapped,
 *  don't snap to anything nearby" entry in the disambiguation picker. */
export const CURRENT_POSITION_LABEL = 'Current position'

/** Readable label for an obstacle's `kind` property (se-obstacles.geojson). */
export const OBSTACLE_KIND_LABEL: Record<string, string> = {
  wind_turbine: 'Wind Turbine',
  tower:        'Tower',
  chimney:      'Chimney',
  building:     'Building',
  other:        'Obstacle',
}

/** Readable label for a landmark's `kind` property (se-landmarks.geojson). */
export const LANDMARK_KIND_LABEL: Record<string, string> = {
  church:       'Church',
  mast:         'Mast',
  windmill:     'Windmill',
  water_tower:  'Water Tower',
  chimney:      'Chimney',
}

/**
 * Build a display name for an obstacle when it has no `name` property (most
 * don't — the OpenAIP source data leaves `name` as an empty string for the
 * vast majority of obstacles, not null/undefined, so a plain `??` fallback
 * never triggers). Falls back to "<readable kind> · <height>" using the
 * obstacle's own height above ground when known, else its ground elevation.
 */
export function formatObstacleName(props: {
  name?: string | null
  kind?: string | null
  height_m?: number | null
  elevation_ft?: number | null
}): string {
  const name = props.name?.trim()
  if (name) return name
  const kindLabel = OBSTACLE_KIND_LABEL[props.kind ?? ''] ?? 'Obstacle'
  if (props.height_m && props.height_m > 0) {
    return `${kindLabel} · ${Math.round(props.height_m)} m AGL`
  }
  if (props.elevation_ft && props.elevation_ft > 0) {
    return `${kindLabel} · ${Math.round(props.elevation_ft)} ft elev`
  }
  return kindLabel
}

/**
 * Short display name for an obstacle when used as a persisted ROUTE
 * WAYPOINT name (VirtualRadar's on-chart waypoint-tick label, the route
 * leg table, saved-route storage) rather than a one-off disambiguation
 * picker entry. Unlike formatObstacleName's "<kind> · <height>" fallback
 * (genuinely useful in SnapPicker's candidate list, where two unnamed
 * obstacles near the same click point need a way to tell them apart), the
 * height suffix has no ongoing value once baked into a route -- it just
 * clutters chart/table space that's already tight, permanently, for every
 * future view of that route. Falls back to the plain kind label with no
 * height/elevation appended. Use formatObstacleName for the picker's own
 * candidate list (kept as the caller's `displayName`), and this for the
 * `waypoint.name` that actually gets stored once a candidate is picked.
 */
export function obstacleWaypointName(props: { name?: string | null; kind?: string | null }): string {
  const name = props.name?.trim()
  if (name) return name
  return OBSTACLE_KIND_LABEL[props.kind ?? ''] ?? 'Obstacle'
}

/** Same idea as formatObstacleName but for landmarks (no height data available). */
export function formatLandmarkName(props: { name?: string | null; kind?: string | null }): string {
  const name = props.name?.trim()
  if (name) return name
  return LANDMARK_KIND_LABEL[props.kind ?? ''] ?? 'Landmark'
}

const LANDMARK_ONLY_KINDS = new Set(['church', 'mast', 'windmill'])
const OBSTACLE_ONLY_KINDS = new Set(['wind_turbine', 'tower', 'building', 'other'])

/**
 * Whether a feature with a plain `kind` property is an obstacle (OBS) rather than a landmark (LMK), for
 * clients whose map query does not say which layer matched. Both carry `kind` and `height_m` (a church
 * has one too), so neither says it; the kind value does where it is exclusive, else the obstacles' own
 * surveyed `elevation_ft`, which landmarks do not have.
 */
export function isObstacleFeature(props: { kind?: unknown; elevation_ft?: unknown }): boolean {
  const kind = typeof props.kind === 'string' ? props.kind : ''
  if (LANDMARK_ONLY_KINDS.has(kind)) return false
  if (OBSTACLE_ONLY_KINDS.has(kind)) return true
  return props.elevation_ft !== undefined && props.elevation_ft !== null
}

const OBSTACLE_ICON: Record<string, string> = {
  wind_turbine: 'obs-wind-turbine', tower: 'obs-tower', chimney: 'obs-chimney', building: 'obs-building',
  water_tower: 'lmk-water-tower', other: 'obs-other',
}
const LANDMARK_ICON: Record<string, string> = {
  church: 'lmk-church', mast: 'lmk-mast', windmill: 'lmk-windmill', water_tower: 'lmk-water-tower', chimney: 'lmk-chimney',
}

/**
 * Name of the map icon (`poi_icons/<name>`) a picker row shows instead of a text badge, for obstacles
 * and landmarks: the same pictogram the map draws says what it is better than "OBS" / "LMK". Null for
 * every other kind, which keeps its text badge.
 */
export function snapIconName(badge: string, kind?: unknown): string | null {
  const k = typeof kind === 'string' ? kind : ''
  if (badge === 'OBS') return OBSTACLE_ICON[k] ?? 'obs-other'
  if (badge === 'LMK') return LANDMARK_ICON[k] ?? 'lmk-church'
  return null
}
