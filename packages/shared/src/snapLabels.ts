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

/** Same idea as formatObstacleName but for landmarks (no height data available). */
export function formatLandmarkName(props: { name?: string | null; kind?: string | null }): string {
  const name = props.name?.trim()
  if (name) return name
  return LANDMARK_KIND_LABEL[props.kind ?? ''] ?? 'Landmark'
}
