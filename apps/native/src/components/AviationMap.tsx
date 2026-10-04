/**
 * AviationMap — full-screen MapLibre GL Native map with aviation overlay layers.
 * Uses @maplibre/maplibre-react-native v11 API (named exports, Layer component).
 */

import React, { useRef, useCallback, useMemo, useEffect, useState } from 'react'
import { StyleSheet, View, Text, TouchableOpacity, ScrollView, Linking } from 'react-native'
import {
  Map,
  Camera,
  GeoJSONSource,
  VectorSource,
  RasterDEMSource,
  Layer,
  Images,
  UserLocation,
  ViewAnnotation,
  type CameraRef,
  type MapRef,
  type ViewAnnotationEvent,
  type ViewAnnotationRef,
  type GeoJSONSourceRef,
} from '@maplibre/maplibre-react-native'
import type { NativeSyntheticEvent } from 'react-native'
import type { PressEvent, PressEventWithFeatures } from '@maplibre/maplibre-react-native'
import type { Feature, FeatureCollection } from 'geojson'
import type { ViewStateChangeEvent } from '@maplibre/maplibre-react-native'
import { WAYPOINT_COLORS, RUNWAY_COLORS, AERODROME_COLORS } from '@open-vfr/shared/featureColors'
import { computeAtcStatus, isNotamAtcRelated, isNotamHoursChangeRelated, type HoursEntry as AtcHoursEntry } from '@open-vfr/shared/atcStatus'
import { sunriseSunset } from '@open-vfr/shared/sunCalc'
import { ATTRIBUTION_SOURCES } from '@open-vfr/shared/attributionSources'
import { MapInfoBar, type MapInfoBarHandle } from './MapInfoBar'
import { fetchAerodromeNotamTexts } from '@open-vfr/shared/fetchNotam'
import { API_BASE, TILE_BASE } from '../config'
import { LIGHT } from '@protomaps/basemaps'
import { NativeSheet } from './NativeSheet'
import { waitForTileManifest } from '@open-vfr/shared/tileManifest'
import { authHeaders } from '../utils/authClient'
import {
  buildRunwayWindHighlight,
  type RunwayWindHighlightEnd,
} from '@open-vfr/shared/runwayWind'
import { AIRSPACE_COLORS as AC, CONTROLLED_CLASSES, ZONE_TYPES, controlledStyle } from '@open-vfr/shared/airspaceColors'
import { formatObstacleName, formatLandmarkName, obstacleWaypointName, CURRENT_POSITION_LABEL } from '@open-vfr/shared/snapLabels'

import {
  BASEMAP_STYLE_URL,
  SATELLITE_STYLE,
  createProtomapsStyle,
  getLandusePmtilesUrl,
  getHillshadePmtilesUrl,
  getContoursPmtilesUrl,
  getTileUrls,
} from '../config'
import type { GpsPosition } from '../utils/gpsTypes'
import type { RouteWaypoint } from '../utils/routeCalc'
import { advancePosition } from '../utils/routeCalc'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import { OFFLINE_ASSETS, resolveUri } from '../utils/offlineCache'
import { buildTerrainColorExpr } from '@open-vfr/shared/terrainColor'
import { useWindGrid } from '../hooks/useWindGrid'
import { useResilientTileData } from '../hooks/useResilientTileData'
import { LogManager } from '@maplibre/maplibre-react-native'
import { useStoreValue, type ValueStore } from '../utils/valueStore'

// Suppress the PMTiles header-race transient error at cold start -- same
// benign race web's MapView.tsx suppresses in its map.on('error', ...)
// handler: the pmtiles archive header read races the initial response
// (dev-server/CDN warm-up, connection still establishing); the library
// retries internally and the map loads fine right after (confirmed via
// on-device logcat + screenshot -- map renders correctly a moment later).
// Native's own logger reports it as an 'error'-level 'Style' log before
// that retry resolves it, with different wording ('...magic number
// exception' vs web's 'Wrong magic number') but the same underlying race.
// MapLibre Native's MapView already calls LogManager.start()/stop() itself
// on mount/unmount, so registering the filter here at module scope (not
// per-mount) is enough -- onLog only ever holds one handler, so this must
// not be duplicated elsewhere.
LogManager.onLog(({ level, message }) => {
  if (level === 'error' && message.includes('magic number exception')) return true
  return false
})

/** Resolves each tile key to its cached local file:// URI if downloaded, else the (versioned) remote URL. */
function getResolvedTileUrls() {
  const tileUrls = getTileUrls()
  const resolved: Record<string, string> = {}
  for (const key of Object.keys(tileUrls)) {
    const asset = OFFLINE_ASSETS.find(a => a.key === key)
    resolved[key] = asset ? resolveUri(asset) : (tileUrls as Record<string, string>)[key]
  }
  return resolved as typeof tileUrls
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export type AviationMapProps = {
  gpsPosition?: GpsPosition | null
  /** True once a simulator/external position feed is supplying gpsPosition
   *  instead of the device's own GPS. Used to re-center the camera the
   *  moment the position source switches, without requiring the user to
   *  tap a manual recenter/follow button. */
  simActive?: boolean
  waypoints?: RouteWaypoint[]
  airspaceCeilingFt?: number
  /** Distance unit for the scale bar. Defaults to nautical miles. */
  distanceUnit?: 'nm' | 'km'
  showClassCtr?:   boolean
  showClassCtma?:  boolean
  showClassG?:     boolean
  showRestricted?: boolean
  showActivity?:   boolean
  showAerodromes?: boolean
  showNavaids?:    boolean
  showWaypoints?:  boolean
  showObstacles?:  boolean
  showRunways?:    boolean
  /** Wind-favored runway end for whichever aerodrome's popup is currently
   * open (reported by AerodromePopup's onRunwayWind → MapScreen state) --
   * mirrors web's MapView.runwayWindHighlight. Null/undefined = no highlight,
   * i.e. plain default runway-threshold-label styling everywhere. */
  runwayWindHighlight?: { icao: string; ends: RunwayWindHighlightEnd[] } | null
  showLandmarks?:  boolean
  showLanduse?:    boolean
  showHillshade?:  boolean
  showContours?:   boolean
  /** EXPERIMENTAL — color-relief has a known GPU/Adreno rendering bug on
   *  some Android devices (RGBA32F texture format not mandatory in the
   *  Vulkan spec). Off by default; exists so this can be verified on real
   *  hardware before treating it as a shippable feature. See AGENTS.md. */
  showTerrainColor?:      boolean
  /** Reference altitude (ft) for the terrain colour-relief bands. Ignored
   *  in favour of live gpsPosition.altFt when flying, same as web. */
  terrainColorRefAltFt?:  number
  /** Ambient wind-barb overlay (grid-sampled Open-Meteo wind) -- fed by
   *  this component's own camera-state-derived useWindGrid call (no
   *  map.getBounds() escape hatch on native the way web's maplibre-gl JS
   *  Map has -- see hooks/useWindGrid.ts). Matches web's 'wind-grid'
   *  source/'wind-arrows-icon' layer exactly (same bucketed icon-id
   *  expression, dirDeg rotation, bottom anchor). */
  showWind?: boolean
  followGps?: boolean
  /** Called when the pilot manually pans/zooms/rotates the map while
   *  followGps is on -- lets the parent drop out of follow mode instead of
   *  fighting the gesture (see onRegionIsChanging's userInteraction check
   *  below). Without this, followGps's own recenter effect re-issues an
   *  easeTo back to the GPS position on every position tick, which both
   *  visibly snaps the map back mid-drag and, in a burst, can retrigger
   *  React's synchronous update-depth guard (see camForWind throttle
   *  below for the other half of that same race). */
  onUserPan?: () => void
  /** Passive location mode: draw the device's own position (dot, accuracy
   *  circle, heading arrow) without moving the camera. Location permission
   *  must already be granted by the parent. */
  showOwnPosition?: boolean
  /** Draw the aircraft (ownship) icon at gpsPosition. False while on the
   *  ground with location Off -- GPS may still be running for proximity
   *  features, but the map shouldn't show a position the pilot turned off.
   *  gpsPosition still drives camera follow either way. */
  showAircraft?: boolean
  mapOrientation?: 'north' | 'track'
  autoZoom?: boolean
  /** Optional initial center — fly to this on first load (home airfield) */
  initialCenter?: [number, number]
  initialZoom?:   number
  basemapMode?:   'vector' | 'satellite'
  /** NM to project trajectory ahead (default 5). In time mode: minutes × speed. */
  trajectoryNm?: number
  /** Completed flight log track being viewed (Logs segment "View" action) —
   *  rendered as a violet line, camera auto-fits to its bounds when it
   *  changes from null → a track (or to a different track). Pass null/empty
   *  to hide and stop fitting. */
  pastTrack?: [number, number][]
  /** Id of the saved-route row the working route is currently linked to
   *  ('' = untitled/unlinked) -- RouteContext's activeRouteId, changed by
   *  RouteLibrarySheet's handleLoad/Save As, GPX import, and New Route.
   *  Used purely as a change-signal to fit the camera to the route's
   *  bounds right after a *load* (or Save As / GPX import), without
   *  re-fitting on every incremental tap-to-add-a-waypoint edit during
   *  planning (which wouldn't touch this id) or on the initial mount's
   *  cold-start restore of the last session's route (guarded separately,
   *  see the effect below -- that already gets its own flyTo via
   *  initialCenter/home-airfield centering, and fighting it with a second
   *  competing camera move on the very first render would be jarring). */
  activeRouteId?: string
  /** Changes whenever a whole route is loaded or re-shown: fit the camera to it. */
  routeFitNonce?: number
  /** Map-side crosshair marker driven by a chart hover/scrub (VerticalProfile
   *  or PastTrackChart touch-drag) — [lng, lat], or null to hide. A store so
   *  scrub updates re-render only the marker layer, not the whole map. */
  profileCursorStore?: ValueStore<[number, number] | null>
  /** 'time' = marks at 1/3/5 min ahead; 'nm' = marks at 1/3/5 NM ahead */
  trajectoryMode?: 'time' | 'nm'
  onFeatureTap?:  (features: Feature[], lngLat: [number, number]) => void
  onLongPress?:   (feature: Feature) => void
  /** Called when a route waypoint is dragged to a new position */
  onWaypointMove?: (index: number, pos: { lat: number; lng: number }) => void
  /** Called when a route leg is tapped — insert waypoint after legIndex */
  onLegTap?:       (afterIndex: number, pos: { lat: number; lng: number }) => void
  /** Fired when an existing waypoint is drag-released near 2+ snap targets —
   *  caller should show a disambiguation picker; picking calls onWaypointMove. */
  onWaypointMoveCandidates?: (index: number, candidates: SnapCandidate[]) => void
  /** Fired on a long-hold-in-place (no movement) on an existing route
   *  waypoint's drag handle — caller should offer to remove it from the
   *  route (mirrors web's stationary-tap-in-adjust-mode WpActionMenu). */
  onWaypointLongPress?: (index: number, lat: number, lng: number) => void
  /** Fired on a double-tap on an existing route waypoint — caller should
   *  remove it from the route immediately (no confirmation). Replaces the
   *  earlier long-press-to-remove gesture, which the native draggable
   *  ViewAnnotation only reliably delivered when actual finger movement
   *  accompanied the hold — a still long-press is inconsistent across
   *  devices, double-tap is not. */
  onWaypointRemove?: (index: number) => void
  /** Fired when a leg-midpoint drag-insert resolves to exactly one waypoint
   *  (raw coordinate or a single unambiguous snap target). */
  onLegInsert?: (afterIndex: number, wp: RouteWaypoint) => void
  /** Fired when a leg-midpoint drag-insert is near 2+ candidate snap targets
   *  — caller should show a disambiguation picker; picking calls onLegInsert. */
  onLegInsertCandidates?: (afterIndex: number, candidates: SnapCandidate[]) => void
  trafficFC?:     FeatureCollection
  /** User-saved waypoints (from UserWaypointContext) — shown as bookmark pins,
   *  independent of the planned route. */
  userWaypointsFC?: FeatureCollection
  /** Ad-hoc circles for FIR-wide NOTAMs (restricted/danger areas, navaid
   *  outages, military notices) built from each NOTAM's own coordinates+
   *  radius -- see apps/native/src/hooks/useRegionalNotams.ts. Mirrors web's
   *  MapView.tsx 'notam-circles' source. */
  notamCirclesFC?: FeatureCollection
  /** Point-only regional NOTAMs (coordinates present, no usable radius --
   *  obstacle lights, single-point navaid faults). Rendered as clustered
   *  pins, mirroring web's MapView.tsx 'notam-points' source -- see that
   *  source's own comment for why clustering needs Point geometry and thus
   *  a separate source from notamCirclesFC's Polygon geometry. */
  notamPointsFC?: FeatureCollection
  /** Real multi-vertex area geometry for regional NOTAMs, straight from
   *  NMS-API's own GeoJSON feature.geometry -- see apps/api/src/notam.ts's
   *  extractNotamPolygon(). Distinct from notamCirclesFC above: takes
   *  priority over the synthesized circle when a NOTAM has both. Mirrors
   *  web's MapView.tsx 'notam-polygons' source. */
  notamPolygonsFC?: FeatureCollection
  /** Route planning mode — mirrors web's "Plan route" button. While true,
   *  every map tap adds a waypoint (snapped to a nearby feature within a
   *  screen-pixel radius when unambiguous) instead of opening feature popups. */
  planningMode?: boolean
  /** Disables waypoint/leg-midpoint drag entirely regardless of
   *  onWaypointMove/onLegInsert being set — used while flying so an
   *  accidental touch while panning the map can never move a leg. The
   *  caller (MapScreen.tsx) sets this true whenever airborne and gates it
   *  off only via an explicit "Adjust Route" toggle, mirroring web's
   *  MapView.tsx routeAdjustMode gating on the route-line drag handlers. */
  editLocked?: boolean
  /** Fired when a plan-mode tap resolves to exactly one waypoint (raw
   *  coordinate or a single unambiguous snap target). */
  onPlanTap?: (wp: RouteWaypoint) => void
  /** Fired when a plan-mode tap is near 2+ candidate snap targets — caller
   *  should show a disambiguation picker anchored at screenPoint. */
  onPlanCandidates?: (candidates: SnapCandidate[], screenPoint: [number, number]) => void
  /** Show the drawn route (line + waypoint pins). Defaults to true — set
   *  false to hide an existing route without clearing its waypoints
   *  (route activate/deactivate). */
  routeVisible?: boolean
  /** Map Ruler mode — mirrors web's MapView.tsx ruler tool. While true,
   *  every map tap sets/rolls the two measurement points (A, then B, then
   *  each further tap replaces A with the old B and sets a new B) instead
   *  of opening feature popups or adding a route waypoint. */
  rulerMode?: boolean
  /** Current ruler points (0-2), used to draw the measurement line + point
   *  markers. Owned by the caller (MapScreen), not this component. */
  rulerPoints?: RouteWaypoint[]
  /** Fired with the new rulerPoints array after a ruler-mode tap. */
  onRulerTap?: (points: RouteWaypoint[]) => void
  /** Fired once, the moment the basemap style finishes its own initial load
   *  (mirrors the internal styleLoaded/onDidFinishLoadingStyle gate this
   *  component already uses to stagger landuse/hillshade/contours mounting
   *  -- see the readyStage comment below). The parent screen (MapScreen)
   *  uses this to delay its OWN first-mount network bursts (traffic SSE,
   *  regional NOTAMs, weather-along-route, wind) so they don't stack on top
   *  of the PMTiles basemap load during the same cold-start memory spike
   *  that caused the OOM crashes this gate exists for -- see
   *  HANDOFF_oom_investigation.md next-steps #1. Not the same signal as
   *  onDidFinishLoadingMap (full map, incl. all sources/layers) -- style-
   *  loaded is deliberately the EARLIEST safe point, so the map itself still
   *  gets first claim on bandwidth/memory ahead of these secondary fetches. */
  onMapReady?: () => void
  /** Pan/zoom the camera to a point — e.g. Find-a-Destination panel's row
   *  tap. `nonce` must change on every request (even repeat taps on the
   *  same aerodrome) since [lat,lng] alone wouldn't re-trigger the effect. */
  /** Fly the camera here; zoom defaults to 13 when omitted. */
  flyToTarget?: { lat: number; lng: number; zoom?: number; nonce: number } | null
}

/** A route-planning snap candidate — a nearby feature the user might mean
 *  when tapping near several overlapping points. Mirrors web's SnapPicker. */
export type SnapCandidate = {
  kind: string
  waypoint: RouteWaypoint
  /** Verbose picker-only label -- see extractSnapDisplayName below. */
  displayName?: string
}

// Layers that are valid snap targets during route planning (mirrors web's
// SNAP_LAYERS in MapView.tsx). Obstacles/landmarks are not useful turning
// points but are still offered, matching web.
const SNAP_LAYERS = [
  'aerodromes-circle',
  'navaids-circle',
  'waypoints-mrp-circle', 'waypoints-rp-circle',
  'obstacles-circle',
  'landmarks-circle',
  'user-waypoints-circle',
]

/** Extract the short identifier STORED as a snapped route-planning
 *  feature's `waypoint.name` -- persists into the route (leg list,
 *  VirtualRadar waypoint-tick label, saved-route storage), so obstacles
 *  deliberately use the kind-only `obstacleWaypointName` here rather than
 *  formatObstacleName's elevation-suffixed fallback -- see
 *  extractSnapDisplayName below for the picker-only verbose form. */
function extractSnapName(feat: Feature): string {
  const p = (feat.properties ?? {}) as Record<string, unknown>
  if (typeof p.icao === 'string' && p.icao) return String(p.icao)
  // Obstacles/landmarks: most have no `name` at all (OpenAIP leaves it as an
  // empty string, not null/undefined, so a plain `p.name ?? ...` fallback
  // never triggers) — fall back to a readable kind label instead of showing
  // a blank row in the disambiguation picker.
  if (extractSnapKind(feat) === 'OBS') {
    return obstacleWaypointName({
      name: typeof p.name === 'string' ? p.name : undefined,
      kind: typeof p.kind === 'string' ? p.kind : undefined,
    })
  }
  if (extractSnapKind(feat) === 'LMK') {
    return formatLandmarkName({
      name: typeof p.name === 'string' ? p.name : undefined,
      kind: typeof p.kind === 'string' ? p.kind : undefined,
    })
  }
  // User waypoints: `id` is a random UUID (primary key), never a readable
  // identifier like navaids/MRP/RP use theirs for — must prefer `name` or
  // the picker/route shows a raw UUID instead of the name the user gave it.
  if (extractSnapKind(feat) === 'UWP') {
    return String((typeof p.name === 'string' && p.name) || 'UWP')
  }
  const id = p.id
  const name = p.name
  return String((typeof id === 'string' && id) || (typeof name === 'string' && name) || p.kind || 'WP')
}

/** Verbose form of the same feature's name, for the disambiguation picker's
 *  candidate list only -- NOT stored anywhere. Only obstacles differ from
 *  extractSnapName (elevation suffix helps tell apart two unnamed
 *  obstacles near the same tap point, a one-off disambiguation need that
 *  extractSnapName's persisted short name deliberately drops). Every other
 *  feature type's display name is identical to its stored name. */
function extractSnapDisplayName(feat: Feature): string {
  const p = (feat.properties ?? {}) as Record<string, unknown>
  if (extractSnapKind(feat) === 'OBS') {
    return formatObstacleName({
      name: typeof p.name === 'string' ? p.name : undefined,
      kind: typeof p.kind === 'string' ? p.kind : undefined,
      height_m: typeof p.height_m === 'number' ? p.height_m : undefined,
      elevation_ft: typeof p.elevation_ft === 'number' ? p.elevation_ft : undefined,
    })
  }
  return extractSnapName(feat)
}

/** Short kind badge for the disambiguation picker. */
function extractSnapKind(feat: Feature): string {
  const p = (feat.properties ?? {}) as Record<string, unknown>
  if (typeof p.icao === 'string' && p.icao) return 'AD'
  if (p.kind === 'VOR' || p.kind === 'NDB') return String(p.kind)
  if (p.wp_type === 'MRP' || p.wp_type === 'RP') return String(p.wp_type)
  if (p.folder !== undefined) return 'UWP'
  // Obstacles and landmarks both use a plain `kind` string property (and
  // some kind VALUES even overlap, e.g. 'chimney') so `kind` alone can't
  // tell them apart — native queryRenderedFeatures results don't carry back
  // which layer matched, unlike web's MapGeoJSONFeature.layer.id. Obstacles
  // are the only one of the two with elevation/height properties.
  if (typeof p.kind === 'string' && (p.elevation_ft !== undefined || p.height_m !== undefined)) return 'OBS'
  if (typeof p.kind === 'string') return 'LMK'
  return 'WP'
}

/** Dedupe raw queryRenderedFeatures hits into SnapCandidates by
 *  kind+name+position (mirrors web's buildCandidates in MapView.tsx) —
 *  shared by plan-mode tap, waypoint-move release, and leg-midpoint-insert
 *  release.
 *
 *  Position must be part of the key, not just kind+name: most obstacles
 *  have no `name` property at all, so extractSnapName falls back to the
 *  shared `kind` string (e.g. every unnamed tower dedupes to "obs-tower").
 *  Keying on name+kind alone collapsed 2+ distinct nearby obstacles/POIs
 *  into a single picker entry, silently hiding all but the first hit. The
 *  position component still correctly collapses genuine duplicates (the
 *  same feature returned twice across a tile boundary). */
function buildSnapCandidates(hits: Feature[], custom?: RouteWaypoint): SnapCandidate[] {
  const seen = new Set<string>()
  const out: SnapCandidate[] = []
  for (const feat of hits) {
    if (feat.geometry.type !== 'Point') continue
    const [lng, lat] = feat.geometry.coordinates as [number, number]
    const name = extractSnapName(feat)
    const kind = extractSnapKind(feat)
    const key  = `${kind}:${name}:${lat.toFixed(5)}:${lng.toFixed(5)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind, displayName: extractSnapDisplayName(feat), waypoint: { lng, lat, name } })
  }
  // Always offer the exact drop/tap location too — mirrors web's picker
  // (user should be able to reject every nearby suggestion and keep a plain
  // custom waypoint at precisely where they dropped/tapped, not just be
  // forced to pick one of the snap targets or silently auto-snap).
  if (custom) out.push({ kind: 'PT', waypoint: custom })
  return out
}

const SNAP_PX = 20
// While a route point is being dragged the effective drop position is the
// finger position shifted UP by this many screen points, so the point being
// placed stays visible above the fingertip instead of under it.
const DRAG_LIFT_PX = 72
// Colour of the route as it would be after the drop (the original route is
// left in place, faded, while dragging).
const DRAG_ROUTE_COLOR = '#ff9800'

// ---------------------------------------------------------------------------
// Airspace expressions
// ---------------------------------------------------------------------------
// Sourced entirely from @open-vfr/shared/airspaceColors — the single canonical
// palette also used by web's map-style.ts. Previously native had its own
// hardcoded copy in theme.ts (theme.airspaceC/D/E/G) that was missing the
// CTR-vs-TMA distinction entirely (always showed the CTR purple for all of
// class C, TMA included) and could silently drift out of sync with web's
// colours since nothing enforced they stay identical. 'case' is used instead
// of 'match' because the CTR/TMA split needs a compound condition (class AND
// type), which a flat match on a single property can't express.
// Airspace on-map label text — class/type short code + altitude range, placed
// along the boundary line (symbol-placement: 'line'). Same technique + text
// content as web's map-style.ts AIRSPACE_LABEL_TEXT_FIELD.
// Runway line colour per surface; one static-colour layer each (see asVariants).
const RUNWAY_SURFACES = [
  { k: 'asph',  f: ['==', ['get', 'surface'], 'ASPH'], col: RUNWAY_COLORS.asphalt },
  { k: 'conc',  f: ['==', ['get', 'surface'], 'CONC'], col: RUNWAY_COLORS.concrete },
  { k: 'grass', f: ['!', ['in', ['get', 'surface'], ['literal', ['ASPH', 'CONC']]]], col: RUNWAY_COLORS.grass },
]

const LANDMARK_LABEL_COLORS = [
  { k: 'mast',        f: ['==', ['get', 'kind'], 'mast'],        col: '#e65100' },
  { k: 'windmill',    f: ['==', ['get', 'kind'], 'windmill'],    col: '#5d4037' },
  { k: 'water-tower', f: ['==', ['get', 'kind'], 'water_tower'], col: '#00695c' },
  { k: 'chimney',     f: ['==', ['get', 'kind'], 'chimney'],     col: '#bf360c' },
  { k: 'other',       f: ['!', ['in', ['get', 'kind'], ['literal', ['mast', 'windmill', 'water_tower', 'chimney']]]], col: '#455a64' },
]

const AIRSPACE_LABEL_TEXT_FIELD: any = [
  'concat',
  ['match', ['get', 'type'], 'CTR', ['concat', 'CTR ', ['get', 'class']], ['get', 'class']],
  ' ',
  ['get', 'lower'],
  '-',
  ['get', 'upper'],
]

// Restricted areas (R) and TRAs already have a unique, self-describing
// designator in their 'name' property (e.g. 'ESR1 ESRANGE', 'ESTRA80') —
// showing that is far more useful than the generic 'R'/'TRA' class code.
const AIRSPACE_ZONE_LABEL_TEXT_FIELD: any = ['concat', ['get', 'type'], ' ', ['get', 'lower'], '-', ['get', 'upper']]

const AIRSPACE_RESTRICTED_LABEL_TEXT_FIELD: any = [
  'concat',
  ['get', 'name'],
  '  ·  ',
  ['get', 'lower'],
  ' – ',
  ['get', 'upper'],
]

// ---------------------------------------------------------------------------
// Route GeoJSON helpers — per-leg and per-waypoint features with index props
// ---------------------------------------------------------------------------

/** One LineString per leg, each with { featureType:'leg', legIndex:i } */
// lat/lng: lifted drop position used for rendering and the commit.
// fingerLat/fingerLng: the raw position the native drag reports (where the
// invisible hit-target symbol actually is); fed back to that annotation so
// React and the native side agree on where it is.
type DragPreview = { wpIndex: number; lat: number; lng: number; fingerLat?: number; fingerLng?: number } | null
type LegDragPreviewT = { legIndex: number; lat: number; lng: number } | null

/** Waypoints with the leg-insert preview point spliced in after legIndex. */
function withInserted(wps: RouteWaypoint[], p: LegDragPreviewT): RouteWaypoint[] {
  if (!p) return wps
  const next = wps.slice()
  next.splice(p.legIndex + 1, 0, { lat: p.lat, lng: p.lng })
  return next
}

function withPreview(wps: RouteWaypoint[], preview: DragPreview): RouteWaypoint[] {
  if (!preview) return wps
  return wps.map((w, i) => (i === preview.wpIndex ? { ...w, lat: preview.lat, lng: preview.lng } : w))
}

function routeLegsGeoJSON(wps0: RouteWaypoint[], preview: DragPreview = null): FeatureCollection {
  const wps = withPreview(wps0, preview)
  if (wps.length < 2) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: wps.slice(0, -1).map((from, i) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [wps[i + 1].lng, wps[i + 1].lat]] },
      properties: { featureType: 'leg', legIndex: i },
    })),
  }
}

/** One Point per waypoint with { featureType:'wp', wpIndex:i } */
function routePointsGeoJSON(wps0: RouteWaypoint[], preview: DragPreview = null): FeatureCollection {
  const wps = withPreview(wps0, preview)
  return {
    type: 'FeatureCollection',
    features: wps.map((w, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [w.lng, w.lat] },
      properties: { featureType: 'wp', wpIndex: i, name: w.name ?? `WP${i + 1}` },
    })),
  }
}

function aircraftGeoJSON(pos: GpsPosition): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] },
      properties: { trackDeg: pos.trackDeg },
    }],
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
const FARMLAND_CREAM = 'rgba(232, 240, 218, 0.85)'

const LANDUSE_FILLS = [
  { k: 'farmland',    kind: 'farmland',    col: FARMLAND_CREAM },
  { k: 'residential', kind: 'residential', col: 'rgba(230,230,230,0.8)' },
  { k: 'commercial',  kind: 'commercial',  col: 'rgba(222,220,230,0.8)' },
  { k: 'industrial',  kind: 'industrial',  col: 'rgba(209,221,225,0.8)' },
  { k: 'wetland',     kind: 'wetland',     col: 'rgba(188,220,235,0.8)' },
]

/** Lazy singleton — stable reference prevents MapLibre style reloads on every re-render.
 *  Recomputed (module-level cache cleared) only via clearProtomapsStyleCache(), called
 *  after an offline download completes so a freshly cached basemap.pmtiles takes effect
 *  without requiring a full app restart. */
let _protomapsStyle: ReturnType<typeof createProtomapsStyle> | null = null
function getProtomapsStyle() {
  if (!_protomapsStyle) {
    const basemapAsset = OFFLINE_ASSETS.find(a => a.key === 'basemap')
    const localUrl = basemapAsset ? resolveUri(basemapAsset) : undefined
    // resolveUri returns the plain remote URL unchanged when not cached (no
    // override needed); only pass an override when it actually resolved to a
    // local file:// URI, so createProtomapsStyle's own TILE_BASE default path
    // still applies otherwise.
    const isLocal = localUrl?.startsWith('file://')
    // Same local-file-override treatment for the shared low-zoom overview --
    // without this it would silently keep hitting the network even in
    // offline mode despite being cached, unlike the detail basemap above.
    const overviewAsset = OFFLINE_ASSETS.find(a => a.key === 'basemapOverview')
    const overviewLocalUrl = overviewAsset ? resolveUri(overviewAsset) : undefined
    const overviewIsLocal = overviewLocalUrl?.startsWith('file://')
    _protomapsStyle = createProtomapsStyle(
      isLocal ? localUrl : undefined,
      overviewIsLocal ? overviewLocalUrl : undefined,
    )
  }
  return _protomapsStyle
}
export function clearProtomapsStyleCache() { _protomapsStyle = null }

// Invisible native-drag hit target positioned at a route waypoint's lng/lat
// via MapLibre's own ViewAnnotation (draggable=true). Dragging is handled
// entirely on the native side (Android/iOS map SDK), NOT via an RN
// PanResponder overlay — a PanResponder sibling view never actually received
// touches because MapLibreGLSurfaceView intercepts all touch input before it
// reaches JS-side gesture responders on sibling views (see AGENTS.md
// "MapLibre RN — touch interception"). ViewAnnotation's native drag support
// sidesteps that bridge entirely: the map SDK itself owns the touch stream
// while dragging and reports lngLat directly, no projectApprox/unproject
// math needed.
/** Yellow marker for a chart scrub position. Subscribes to the cursor store
 *  itself so scrub updates re-render only this source, not AviationMap. */
function ProfileCursorLayer({ store }: { store: ValueStore<[number, number] | null> }) {
  const cursor = useStoreValue(store)
  if (!cursor) return null
  return (
    <GeoJSONSource id="profile-cursor-src" data={{ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: cursor } }] }}>
      <Layer
        id="profile-cursor-circle"
        type="circle"
        paint={{
          'circle-radius': 8,
          'circle-color': '#facc15',
          'circle-opacity': 0.35,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#facc15',
        }}
      />
    </GeoJSONSource>
  )
}

const WaypointDragAnnotation = React.memo(function WaypointDragAnnotation({
  wpIndex, lat, lng, onGrab, onMove, onRelease,
}: {
  wpIndex: number
  lat: number
  lng: number
  onGrab: (wpIndex: number) => void
  onMove: (lat: number, lng: number, point: [number, number]) => void
  onRelease: (point: [number, number]) => void
}) {
  const HALF = 22
  const annotationRef = useRef<ViewAnnotationRef>(null)
  const handleDragStart = useCallback(() => onGrab(wpIndex), [wpIndex, onGrab])
  const handleDrag = useCallback((e: NativeSyntheticEvent<ViewAnnotationEvent>) => {
    const [dLng, dLat] = e.nativeEvent.lngLat
    onMove(dLat, dLng, e.nativeEvent.point)
  }, [onMove])
  // ViewAnnotationEvent (extends PressEvent) already carries the touch's
  // screen-pixel `point` directly — use it as-is for the release snap query
  // instead of round-tripping lngLat through mapRef.project(), which never
  // reliably resolved to a matching on-screen position (queried bbox landed
  // nowhere near any real feature, so the disambiguation picker never
  // appeared). This is exactly the same `point` field the already-working
  // plan-mode tap handler uses (see handleMapPress above).
  const handleDragEnd = useCallback((e: NativeSyntheticEvent<ViewAnnotationEvent>) => {
    onRelease(e.nativeEvent.point)
  }, [onRelease])
  // Android renders ViewAnnotation children by rasterizing them to a bitmap
  // (see ViewAnnotationRef doc comment) — the very first frame can show a
  // stale/default placeholder before that capture completes. Force an
  // explicit refresh once mounted so the (deliberately blank/transparent)
  // hit-box view is captured correctly instead of leaving a leftover default
  // marker glyph on screen.
  //
  // collapsable={false} is required here — MLRNPointAnnotation.kt's
  // updateIconImage() falls back to a built-in Android pin icon
  // (DEFAULT_MARKER) whenever its child View has zero actual native
  // subviews. A plain background-only View with no other distinguishing
  // props is exactly the kind of view RN's Fabric renderer silently
  // view-flattens away (zero real native views produced despite one JS
  // element), so childCount stayed 0 and every route waypoint got an
  // unwanted extra default pin stacked on its 'route-pts-circle' marker.
  useEffect(() => { annotationRef.current?.refresh() }, [])
  return (
    <ViewAnnotation
      id={`wp-drag-${wpIndex}`}
      ref={annotationRef}
      lngLat={[lng, lat]}
      draggable
      onDragStart={handleDragStart}
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
    >
      <View collapsable={false} style={{ width: HALF * 2, height: HALF * 2, backgroundColor: 'transparent' }} />
    </ViewAnnotation>
  )
})

// Non-filled circle handle at the midpoint of a route leg — dragging it
// inserts a brand-new waypoint between the leg's two endpoints, mirroring
// web's route-midpoints-layer handle (MapView.tsx). Same native-drag
// technique as WaypointDragAnnotation, so it's immune to the same
// touch-interception issue that broke a PanResponder-sibling approach.
const LegMidpointAnnotation = React.memo(function LegMidpointAnnotation({
  legIndex, lat, lng, onGrab, onMove, onRelease,
}: {
  legIndex: number
  lat: number
  lng: number
  onGrab: (legIndex: number) => void
  onMove: (lat: number, lng: number, point: [number, number]) => void
  onRelease: (point: [number, number]) => void
}) {
  const RADIUS = 6
  const HALF = 16
  const annotationRef = useRef<ViewAnnotationRef>(null)
  const handleDragStart = useCallback(() => onGrab(legIndex), [legIndex, onGrab])
  const handleDrag = useCallback((e: NativeSyntheticEvent<ViewAnnotationEvent>) => {
    const [dLng, dLat] = e.nativeEvent.lngLat
    onMove(dLat, dLng, e.nativeEvent.point)
  }, [onMove])
  // See WaypointDragAnnotation's handleDragEnd comment — uses the event's own
  // screen-pixel `point`, not mapRef.project().
  const handleDragEnd = useCallback((e: NativeSyntheticEvent<ViewAnnotationEvent>) => {
    onRelease(e.nativeEvent.point)
  }, [onRelease])
  useEffect(() => { annotationRef.current?.refresh() }, [])
  return (
    <ViewAnnotation
      id={`leg-mid-${legIndex}`}
      ref={annotationRef}
      lngLat={[lng, lat]}
      draggable
      onDragStart={handleDragStart}
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
    >
      <View style={{ width: HALF * 2, height: HALF * 2, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{
          width: RADIUS * 2, height: RADIUS * 2, borderRadius: RADIUS,
          borderWidth: 2, borderColor: theme.accentMagenta, backgroundColor: 'transparent',
        }} />
      </View>
    </ViewAnnotation>
  )
})

// Credits list shared with web's MapInfoBar -- see @open-vfr/shared/attributionSources.
const attributionStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  card: {
    backgroundColor: '#1e2530', borderTopLeftRadius: 16, borderTopRightRadius: 16,
    paddingTop: 20, paddingHorizontal: 20, paddingBottom: 32, maxHeight: '70%',
  },
  title: { color: '#fff', fontSize: 17, fontWeight: '700', marginBottom: 12 },
  row: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)' },
  rowName: { color: '#7dd3fc', fontSize: 14, fontWeight: '600' },
  rowNote: { color: '#b5bdc9', fontSize: 12, marginTop: 2 },
  closeBtn: { marginTop: 16, alignSelf: 'center', paddingHorizontal: 24, paddingVertical: 10 },
  closeBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
})

export function AviationMap({
  gpsPosition,
  simActive = false,
  waypoints = [],
  airspaceCeilingFt = 9_500,
  distanceUnit = 'nm',
  showClassCtr   = true,
  showClassCtma  = true,
  showClassG     = true,
  showRestricted = true,
  showActivity   = false,
  showAerodromes = true,
  showNavaids    = true,
  showWaypoints  = true,
  showObstacles  = true,
  showRunways    = true,
  runwayWindHighlight = null,
  showLandmarks  = false,
  showLanduse    = true,
  showHillshade  = false,
  showTerrainColor     = false,
  showContours   = false,
  showWind       = false,
  terrainColorRefAltFt = 2000,
  followGps = false,
  showOwnPosition = false,
  showAircraft = true,
  onUserPan,
  mapOrientation = 'north',
  autoZoom = true,
  initialCenter,
  initialZoom,
  basemapMode   = 'vector' as const,
  trajectoryNm   = 5,
  trajectoryMode = 'time' as const,
  pastTrack,
  activeRouteId,
  routeFitNonce = 0,
  profileCursorStore,
  onFeatureTap,
  onLongPress,
  onWaypointMove,
  onWaypointMoveCandidates,
  onWaypointLongPress,
  onWaypointRemove,
  onLegTap,
  onLegInsert,
  onLegInsertCandidates,
  trafficFC,
  userWaypointsFC,
  notamCirclesFC,
  notamPointsFC,
  notamPolygonsFC,
  planningMode = false,
  editLocked = false,
  onPlanTap,
  onPlanCandidates,
  routeVisible = true,
  rulerMode = false,
  rulerPoints,
  onRulerTap,
  onMapReady,
  flyToTarget,
}: AviationMapProps) {
  const dragStyles = useThemedStyles(makeDragStyles)
  const cameraRef   = useRef<CameraRef>(null)
  const notamPointsSourceRef = useRef<GeoJSONSourceRef>(null)
  // Resolved once per mount (cheap sync fs `.exists` checks) — uses cached local
  // files when the pilot has downloaded offline data via Settings, else remote.
  const runwayWindExpr = useMemo(
    () => buildRunwayWindHighlight(runwayWindHighlight?.icao ?? '', runwayWindHighlight?.ends ?? []),
    [runwayWindHighlight],
  )

  // BUG FIX (same class as web MapView.tsx's identical fix, found live in
  // the same investigation): getResolvedTileUrls()/get*PmtilesUrl() each
  // call versionedTileUrl() internally, but were memoized with an EMPTY
  // dependency array below -- computed once on first render and never
  // recomputed, permanently baking in whatever cachedManifest was (usually
  // still null/not-yet-resolved, since index.js's loadTileManifest() is a
  // real network round trip and this component can mount before it settles)
  // for the entire session. manifestReady (set once waitForTileManifest()
  // resolves, bounded by its own ~3s timeout so a slow/offline launch still
  // degrades gracefully) is added to every affected useMemo's deps below so
  // each recomputes exactly once more, correctly versioned, the moment the
  // manifest is actually available -- cheap synchronous work either way
  // (getResolvedTileUrls doc-commented above as "cheap sync fs .exists
  // checks"), safe to rerun.
  const [manifestReady, setManifestReady] = useState(false)
  useEffect(() => {
    waitForTileManifest(TILE_BASE).then(() => setManifestReady(true))
  }, [])

  const tileUrls = useMemo(() => getResolvedTileUrls(), [manifestReady])

  // Retry-backed data for the static per-country GeoJSON overlay files --
  // see useResilientTileData's doc comment for why this exists (MapLibre
  // Native's own source-URL fetch has no retry, so a single transient
  // network gap otherwise leaves a layer's features permanently missing
  // for the rest of the app session).
  const airspaceData         = useResilientTileData(tileUrls.airspace)
  const aerodromesData       = useResilientTileData(tileUrls.aerodromes)
  const navaidsData          = useResilientTileData(tileUrls.navaids)
  const waypointsData        = useResilientTileData(tileUrls.waypoints)
  const runwaysData          = useResilientTileData(tileUrls.runways)
  const runwayThresholdsData = useResilientTileData(tileUrls.runwayThresholds)
  const obstaclesData        = useResilientTileData(tileUrls.obstacles)
  const landmarksData        = useResilientTileData(tileUrls.landmarks)

  // ── Towered-airport ATC status ring (aerodromes-atc-ring layer) ─────────
  // Cached once from tileUrls.aerodromes, independent of GeoJSONSource's own
  // internal loaded-feature set (which is viewport/rendering-dependent) --
  // same fetch-once-separately pattern as web's MapView.tsx equivalent.
  // Recomputed on a 60s interval, AIP-schedule-derived only (see
  // @open-vfr/shared/atcStatus) -- deliberately never NOTAM-driven, matching
  // AerodromePopup's badge. State (not a ref) since this drives a declarative
  // <Layer paint> prop here, unlike web's imperative setPaintProperty.
  const toweredAerodromesRef = useRef<{ icao: string; lat: number; lng: number; hours: AtcHoursEntry[] }[]>([])
  // ICAO lists per status; the ring layers filter on these (static colour per
  // layer) instead of one data-driven colour expression. Anything in neither
  // list renders with the 'unknown' colour.
  const [atcOpenIcaos, setAtcOpenIcaos]     = useState<string[]>([])
  const [atcClosedIcaos, setAtcClosedIcaos] = useState<string[]>([])
  // NOTAM keyword hint badge (⚠/⏰) -- mirrors web MapView's equivalent.
  // Text-only signal (see @open-vfr/shared/atcStatus), never affects
  // atcRingMatchExpr's color. Cleared (empty filter) whenever the bulk fetch
  // fails/is unauthenticated -- badge layer just shows nothing, same as
  // being logged out on web.
  const [notamHintFilter, setNotamHintFilter] = useState<unknown[]>(['in', ['get', 'icao'], ['literal', []]])
  const [notamHintTextExpr, setNotamHintTextExpr] = useState<unknown>('')

  useEffect(() => {
    let cancelled = false
    fetch(tileUrls.aerodromes)
      .then((r) => r.json())
      .then((fc: FeatureCollection) => {
        if (cancelled) return
        toweredAerodromesRef.current = fc.features
          .filter((f) => f.geometry.type === 'Point' && (f.properties as Record<string, unknown>)?.towered === true)
          .map((f) => ({
            icao:  (f.properties as Record<string, unknown>).icao as string,
            lat:   (f.geometry as GeoJSON.Point).coordinates[1],
            lng:   (f.geometry as GeoJSON.Point).coordinates[0],
            hours: ((f.properties as Record<string, unknown>).hours_of_operation as AtcHoursEntry[] | undefined) ?? [],
          }))
        recomputeAtcRing()
      })
      .catch(() => { /* non-fatal -- ring just stays 'unknown' grey for everyone */ })

    function recomputeAtcRing() {
      const entries = toweredAerodromesRef.current
      if (entries.length === 0) return
      const now = new Date()
      const open: string[] = []
      const closed: string[] = []
      for (const e of entries) {
        const sun = sunriseSunset(e.lat, e.lng, now)
        const { status } = computeAtcStatus(e.hours, sun, now)
        if (status === 'open') open.push(e.icao)
        else if (status === 'closed') closed.push(e.icao)
      }
      setAtcOpenIcaos(open)
      setAtcClosedIcaos(closed)
    }

    const interval = setInterval(recomputeAtcRing, 60_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [tileUrls.aerodromes])

  // Same NOTAM-keyword hint fetch as web's MapView -- one bulk request for
  // every towered airport's active NOTAM texts (GET /api/notam/aerodrome-
  // texts), then applies isNotamAtcRelated/isNotamHoursChangeRelated
  // client-side. Runs on the same 60s cadence as the ring recompute above
  // but as its own effect (independent failure domain -- a NOTAM fetch
  // hiccup shouldn't touch the AIP-schedule ring at all).
  useEffect(() => {
    let cancelled = false

    async function applyNotamHints() {
      const towered = toweredAerodromesRef.current
      if (towered.length === 0) return
      const toweredIcaos = new Set(towered.map((e) => e.icao))
      let texts: Record<string, string[]>
      try {
        const headers = await authHeaders()
        texts = await fetchAerodromeNotamTexts(API_BASE, undefined, headers)
      } catch {
        return  // transient/unauthenticated -- leave previous hint state in place
      }
      if (cancelled) return
      const icaos: string[] = []
      const glyphArgs: string[] = []
      for (const [icao, icaoTexts] of Object.entries(texts)) {
        if (!toweredIcaos.has(icao)) continue
        const atcHit   = icaoTexts.some((t) => isNotamAtcRelated(t))
        const hoursHit = icaoTexts.some((t) => isNotamHoursChangeRelated(t))
        if (!atcHit && !hoursHit) continue
        icaos.push(icao)
        glyphArgs.push(icao, atcHit && hoursHit ? '⚠⏰' : atcHit ? '⚠' : '⏰')
      }
      setNotamHintFilter(['in', ['get', 'icao'], ['literal', icaos]])
      setNotamHintTextExpr(icaos.length > 0 ? ['match', ['get', 'icao'], ...glyphArgs, ''] : '')
    }

    // Towered-aerodrome cache (from the effect above) may not be populated
    // yet on the very first tick -- harmless, just means the very first
    // hint application is a no-op until the next 60s tick after it loads.
    void applyNotamHints()
    const interval = setInterval(applyNotamHints, 60_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [tileUrls.aerodromes])
  // Computed once per mount, same as tileUrls above -- avoids a fresh string
  // (and thus a changed prop) on every render, which risked tripping the
  // 'id cannot be changed' MapLibre Native restriction seen elsewhere in
  // this file if it ever raced with a Fast Refresh reconciliation.
  const landusePmtilesUrl   = useMemo(() => getLandusePmtilesUrl(), [manifestReady])
  const hillshadePmtilesUrl = useMemo(() => getHillshadePmtilesUrl(), [manifestReady])
  const contoursPmtilesUrl  = useMemo(() => getContoursPmtilesUrl(), [manifestReady])

  // Lazy-mount, sticky-on: each of these PMTiles sources is genuinely heavy
  // (landuse 87MB, hillshade 681MB, contours 234MB -- all fetched header-first
  // by MapLibre Native the instant the <VectorSource>/<RasterDEMSource> JSX
  // mounts, regardless of layout.visibility, which only hides the *layer* at
  // paint time, not the source's own loading). Mounting all three
  // unconditionally from app launch (previous behaviour: "always-mounted,
  // toggled via layout.visibility, never unmounted") meant every session paid
  // the full memory cost of every heavy layer whether or not the pilot ever
  // turned it on -- confirmed via `adb logcat` as a genuine OutOfMemoryError
  // in the OkHttp networking thread even with android:largeHeap="true"
  // raising the ceiling to 512MB (see plugins/withAndroidLargeHeap.js),
  // manifesting downstream as "pmtiles magic number exception" (a truncated
  // mid-read response under memory pressure, not a corrupt file -- both
  // the tile host's range-request responses verified byte-correct).
  //
  // Fix: only mount a heavy source once its layer is actually turned on
  // (sticky -- stays mounted once true, MapLibre Native throws "id cannot be
  // changed" if a source is unmounted then re-added, so this can only ever
  // turn on, never off, for the rest of the session). hillshade/terrain-color/
  // contours default OFF, so most sessions never pay their memory cost at
  // all. landuse defaults on (showLanduse=true) -- see the follow-up bug fix
  // below for why its mount is ALSO gated on styleLoaded, not just showLanduse.
  // BUG FIX (found live on device, real OutOfMemoryError confirmed via
  // adb logcat): landuse used to mount immediately on first render because
  // showLanduse defaults true -- right at the exact moment basemap.pmtiles
  // (670MB archive, though only its header + accessed tile ranges are ever
  // actually read into memory) is ALSO doing its first PMTiles header fetch,
  // plus auth/session-restore + initial route/aircraft/waypoint sync +
  // weather/NOTAM/wind fetches all firing at once on a fresh sign-in or cold
  // app restart. That concurrent memory burst hit Android's 512MB largeHeap
  // ceiling (confirmed via adb logcat: "OutOfMemoryError ... target footprint
  // 536870912" inside an OkHttp TaskRunner thread), which then killed the
  // in-flight basemap.pmtiles header fetch mid-stream ("Error fetching
  // PMTiles header: stream was reset: INTERNAL_ERROR") -- surfacing as a
  // completely blank basemap, reproducible specifically on first sign-in and
  // on a fresh app restart (both = the very first Map mount in the process),
  // never on a warm remount later once the startup burst had already settled.
  //
  // Fix, two parts:
  //  1. Don't mount landuse until the basemap style has actually finished
  //     its own initial load (onDidFinishLoadingStyle below) -- staggers the
  //     two heavy PMTiles header fetches instead of racing them at the exact
  //     same moment. hillshade/contours already default off so aren't part
  //     of this startup race in the common case.
  //  2. Auto-retry: onDidFailLoadingMap force-remounts the whole <Map> (key
  //     bump) up to MAP_MAX_AUTO_RETRIES times -- this class of failure is a
  //     transient memory-pressure race, not a permanent config error, and by
  //     the time of a retry the startup burst has typically already settled
  //     (matches what was observed manually: any later remount/relaunch
  //     always succeeded). Camera position is preserved across the remount
  //     via camStateRef (below) instead of resetting to DEFAULT_CENTER.
  const [styleLoaded, setStyleLoaded] = useState(false)
  const [mapRetryKey, setMapRetryKey] = useState(0)
  // Custom attribution dialog — MapLibre Native Android's own attribution
  // dialog (attribution={true}/showAttribution()) silently collapses
  // multiple sources' credits into a single link (confirmed live on device:
  // Protomaps' and Copernicus DEM's attribution strings, both correctly
  // declared on their sources below/in config.ts's createProtomapsStyle,
  // never appeared — only one merged OpenStreetMap entry did, with no way
  // to scroll to the rest). Rather than fight/trust that native dialog,
  // attribution={false} below disables it entirely and this custom button
  // + Modal renders the same curated list README.md's "Data & attribution"
  // section already documents, so it's just kept in sync with that section
  // rather than depending on the SDK to aggregate per-source strings correctly.
  const [showAttribution, setShowAttribution] = useState(false)
  const mapRetryCountRef = useRef(0)
  const MAP_MAX_AUTO_RETRIES = 3
  const handleMapLoadFailure = useCallback(() => {
    if (mapRetryCountRef.current >= MAP_MAX_AUTO_RETRIES) return
    mapRetryCountRef.current += 1
    setStyleLoaded(false)
    setMapRetryKey(k => k + 1)
  }, [])

  // NOTE: all three gates below wait on readyStage (derived from
  // styleLoaded), not just landuse. showHillshade/showTerrainColor/
  // showContours are persisted to AsyncStorage (see
  // docs/pre-release-checklist.md "Native: map-layer visibility toggles ...
  // persisted") -- so a pilot who has ever turned hillshade or contours on
  // will have them come back true immediately on the NEXT cold restart too,
  // hitting the exact same startup-burst OOM race that hit landuse (worse,
  // even: hillshade alone is ~231MB, contours ~117MB, both bigger than
  // landuse's 87MB). Gating on styleLoaded alone isn't enough by itself
  // either though: if a pilot has landuse+hillshade+contours all enabled,
  // one shared boolean would just move the OOM race from "vs. basemap" to
  // "three heavy PMTiles header fetches firing in the same tick vs. each
  // other" (87+231+117MB = ~435MB concurrently, still enough to threaten the
  // 512MB ceiling). Steps (readyStage 1/2/3) spread their header fetches
  // out in time regardless of which subset is actually enabled -- landuse
  // readiness doesn't gate hillshade's timer or vice versa, so a layer
  // that's off doesn't block/delay a later-staged layer that IS on.
  //
  // Retest on a real device (2026-09-16, Samsung SM_S918B, fresh OTP
  // sign-in, full adb logcat) with the ORIGINAL 300ms/600ms steps still
  // reproduced the OOM crash: heap climbed 175MB -> 511MB in ~9s and the
  // process died in a binder thread (`Throwing OutOfMemoryError ... target
  // footprint 536870912`). 300ms/600ms is negligible next to how long a
  // 100-200MB+ PMTiles archive actually takes to fetch over a real network
  // -- by the time landuse's download is still in flight, hillshade's timer
  // has already fired too, so their transfers overlap anyway and peak
  // memory is barely changed from firing all three at once. (One genuine
  // improvement was observed: only 11 canceled Mbgl-HttpRequest entries at
  // crash time vs. the original investigation's "many" -- so the stagger
  // does reduce request *concurrency* somewhat, just not enough to avoid
  // the memory peak.)
  //
  // STRUCTURAL FIX (superseding the fixed-timer version above): stage
  // transitions now wait for the map to actually report a settled frame
  // (`onDidFinishRenderingMapFully`, wired on <Map> below) instead of a
  // guessed delay -- the same "wait for idle before doing the next expensive
  // thing" pattern as MapLibre GL JS's `map.once('idle', cb)`, adapted to
  // the events this RN wrapper actually exposes (no per-source "tiles
  // loaded" event is exposed here, so a settled full-map frame is the
  // closest available proxy: a vector/DEM source can't finish rendering its
  // visible tiles without its header + those tile ranges having already
  // arrived, so this frame event reliably lags the PMTiles fetch it's
  // gating on). STAGE_MIN_MS is a floor so a frame that was already mid-
  // render from the *previous* stage can't count as this stage's signal;
  // STAGE_FALLBACK_MS is a ceiling so a stall (source disabled, no frames
  // due to backgrounding, event never firing on some MapLibre Native
  // version) still can't block forever -- same backstop role the old fixed
  // timer played, just no longer the primary mechanism. This bounds
  // concurrency by an actual readiness signal on any network speed instead
  // of a constant that was already shown not to hold on a slow network.
  const STAGE_MIN_MS = 500
  const STAGE_FALLBACK_MS = 8000
  const [readyStage, setReadyStage] = useState(0)
  const renderTickRef = useRef(0)
  const handleDidFinishRenderingMapFully = useCallback(() => {
    renderTickRef.current += 1
  }, [])
  useEffect(() => {
    if (!styleLoaded) return
    onMapReady?.()
    setReadyStage(1)
  // onMapReady intentionally excluded -- fire exactly once per real
  // styleLoaded transition (incl. auto-retry remounts), not on every render
  // where the caller happens to pass a fresh callback reference.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleLoaded])
  useEffect(() => {
    if (readyStage === 0 || readyStage >= 3) return
    const tickAtStart = renderTickRef.current
    const startedAt = Date.now()
    let cancelled = false
    const poll = setInterval(() => {
      if (cancelled) return
      const elapsed = Date.now() - startedAt
      const settled = elapsed >= STAGE_MIN_MS && renderTickRef.current > tickAtStart
      if (settled || elapsed >= STAGE_FALLBACK_MS) {
        cancelled = true
        clearInterval(poll)
        setReadyStage(s => (s < 3 ? s + 1 : s))
      }
    }, 200)
    return () => { cancelled = true; clearInterval(poll) }
  }, [readyStage])
  const [landuseMounted,   setLanduseMounted]   = useState(false)
  const [hillshadeMounted, setHillshadeMounted] = useState(false)
  const [contoursMounted,  setContoursMounted]  = useState(false)
  useEffect(() => { if (showLanduse && readyStage >= 1) setLanduseMounted(true) }, [showLanduse, readyStage])
  useEffect(() => { if ((showHillshade || showTerrainColor) && readyStage >= 2) setHillshadeMounted(true) }, [showHillshade, showTerrainColor, readyStage])
  useEffect(() => { if (showContours && readyStage >= 3) setContoursMounted(true) }, [showContours, readyStage])

  const mapRef      = useRef<MapRef>(null)

  // Track camera state — read by nav-needle/other features elsewhere below.
  const camStateRef = useRef({ lat: 62, lng: 17, zoom: 5, heading: 0 })
  const infoBarRef = useRef<MapInfoBarHandle>(null)

  // Coarse camera snapshot for useWindGrid below -- only needs to be "close
  // enough", not frame-perfect (the hook itself debounces/dedupes further
  // via its own rounded-key check). That downstream dedupe doesn't help
  // here though: onRegionDidChange/onRegionIsChanging can fire a whole
  // burst of callbacks synchronously within a single JS tick (e.g. the
  // sim's camera easeTo re-issued every 200ms tick, each one restarting/
  // fighting the previous still-animating easeTo) -- calling setCamForWind
  // unconditionally on every one of those queued up enough synchronous
  // re-renders in one go to trip React's "Maximum update depth exceeded"
  // safety limit, even though every individual setState was harmless and
  // the useWindGrid effect itself no-ops on the repeat. Round + compare
  // against the last committed value first so a burst of near-identical
  // frames collapses to at most one actual setState.
  const [camForWind, setCamForWind] = useState<{ lat: number; lng: number; zoom: number } | null>(null)
  const lastCamForWindKeyRef = useRef<string>('')
  // Time floor on top of the spatial-key dedupe above: a fast native drag
  // (or followGps's easeTo fighting one -- see onUserPan doc comment) can
  // deliver onRegionIsChanging at up to display refresh rate, and each
  // frame's center/zoom rounds to a *different* 2-decimal key. That's still
  // one real setState per distinct key, but enough of them land in the same
  // JS macrotask (queued while a previous re-render/effect pass was still
  // flushing) to trip React's synchronous update-depth guard. Capping to
  // one commit per 100ms is coarser than the wind grid needs anyway (it
  // already debounces its own fetch by 800ms).
  const lastCamForWindAtRef = useRef(0)
  // Set just before onUserPan disables followGps, consumed by the
  // "restore north-up" effect further below so it can skip its own
  // bearing-reset easeTo when followGps drops out mid-gesture.
  const disabledByPanRef = useRef(false)

  // Only the wind grid reads camForWind, so only track it while wind arrows
  // are shown: each setCamForWind re-renders all of AviationMap, and during
  // a pan that happened up to 10x a second with the layer off too.
  const showWindRef = useRef(showWind); showWindRef.current = showWind
  const handleRegionChange = useCallback((e: NativeSyntheticEvent<ViewStateChangeEvent>) => {
    const { center, zoom, bearing, userInteraction } = e.nativeEvent
    if (center) {
      camStateRef.current = { lat: center[1], lng: center[0], zoom: zoom ?? 5, heading: bearing ?? 0 }
      infoBarRef.current?.setCamera(center[1], zoom ?? 5)
      // Pilot took manual control of the map -- stop fighting the gesture
      // with followGps's own recenter effect (which re-issues an easeTo
      // back to the GPS position on every position tick otherwise).
      if (userInteraction) { disabledByPanRef.current = true; onUserPan?.() }
      const z = zoom ?? 5
      const key = `${center[1].toFixed(2)},${center[0].toFixed(2)},${z.toFixed(1)}`
      const now = Date.now()
      if (showWindRef.current && key !== lastCamForWindKeyRef.current && now - lastCamForWindAtRef.current >= 100) {
        lastCamForWindKeyRef.current = key
        lastCamForWindAtRef.current = now
        setCamForWind({ lat: center[1], lng: center[0], zoom: z })
      }
    }
  }, [onUserPan])

  // Seed camForWind from the last-known camera state as soon as Wind
  // Arrows is enabled, instead of waiting for the first real pan/zoom to
  // fire onRegionDidChange/onRegionIsChanging -- MapLibre RN does NOT fire
  // either event on initial mount, so without this, enabling the layer on
  // a completely untouched fresh map left useWindGrid's `cam` argument
  // null indefinitely and no barbs ever rendered until the user happened
  // to touch the map. camStateRef.current already holds a usable center/
  // zoom at this point (either the real last-known position from a prior
  // region-change, or the initialViewState default from Camera's own
  // props) -- good enough for the wind grid's coarse 4x4 sample, which
  // will self-correct via a real region-change on the next actual pan
  // anyway. Web's equivalent hook doesn't need this because it calls
  // `map.getBounds()` directly inside its own effect instead of depending
  // on a move-event-driven camera snapshot.
  // Also re-seeds on every switch-on: camForWind isn't tracked while the
  // layer is off (see handleRegionChange), so an old value would be stale.
  useEffect(() => {
    if (!showWind) return
    const { lat, lng, zoom } = camStateRef.current
    lastCamForWindKeyRef.current = ''
    setCamForWind({ lat, lng, zoom })
  }, [showWind])

  const windGridFC = useWindGrid(camForWind, showWind, gpsPosition?.altFt ?? null)

  // Drag state — driven by WaypointDragAnnotation's native ViewAnnotation
  // drag events (lngLat reported directly by the map SDK, no manual
  // projection/unprojection needed; see WaypointDragAnnotation comment above).
  const dragRef = useRef<{ wpIndex: number; lat: number; lng: number } | null>(null)
  // Double-tap-to-remove tracking (see onWaypointRemove doc comment on props).
  const lastWpTapRef = useRef<{ wpIndex: number; time: number } | null>(null)
  const DOUBLE_TAP_MS = 350
  const [dragging, setDragging] = useState(false)
  // Live preview position while dragging — rendered locally only. Committing
  // every pointer-move frame to onWaypointMove (which persists to AsyncStorage
  // and re-renders the full route) made drags laggy and feel disconnected
  // from the finger. Now onWaypointMove/persistence only fires once on release.
  const [dragPreview, setDragPreview] = useState<DragPreview>(null)
  // Mirrors dragPreview so onPanResponderRelease can read the latest value
  // without closing over the state (see panResponder useMemo note below).
  const dragPreviewRef = useRef<DragPreview>(null)

  // Committing a drag move / release — used by each WaypointDragAnnotation's
  // own onDragStart/onDrag/onDragEnd callbacks below.
  const startDrag = useCallback((wpIndex: number, lat: number, lng: number) => {
    dragRef.current = { wpIndex, lat, lng }
    setDragging(true)
  }, [])
  // Set true by releaseDrag, consumed (and cleared) by the very next
  // handleMapPress call — see releaseDrag comment.
  const suppressNextPressRef = useRef(false)
  // Screen point -> map position of the lifted drop point (finger point moved
  // up by DRAG_LIFT_PX). Falls back to the raw position if the conversion fails.
  const liftedLngLat = useCallback(async (
    point: [number, number], fallbackLat: number, fallbackLng: number,
  ): Promise<{ lat: number; lng: number }> => {
    try {
      const ll = await mapRef.current?.unproject([point[0], point[1] - DRAG_LIFT_PX])
      if (ll) return { lat: ll[1], lng: ll[0] }
    } catch { /* fall through */ }
    return { lat: fallbackLat, lng: fallbackLng }
  }, [])
  // Latest-wins guard: unproject is async, and a slow answer for an older
  // move must not overwrite a newer one.
  const dragSeqRef = useRef(0)
  const moveDrag = useCallback((lat: number, lng: number, point: [number, number]) => {
    const d = dragRef.current
    if (!d) return
    const seq = ++dragSeqRef.current
    liftedLngLat(point, lat, lng).then((lifted) => {
      if (seq !== dragSeqRef.current || dragRef.current !== d) return
      const next = { wpIndex: d.wpIndex, lat: lifted.lat, lng: lifted.lng, fingerLat: lat, fingerLng: lng }
      dragPreviewRef.current = next
      setDragPreview(next)
    })
  }, [liftedLngLat])
  const releaseDrag = useCallback((point: [number, number]) => {
    const d = dragRef.current
    const preview = dragPreviewRef.current
    dragRef.current = null
    setDragging(false)
    // Touch-up after a drag also reaches the Map's own tap recognizer (the
    // ViewAnnotation only owns the move stream, not the final click), which
    // would otherwise open the waypoint's tap popup right after a drag.
    // Suppress exactly the next handleMapPress call.
    suppressNextPressRef.current = true
    if (!d || !preview) {
      dragPreviewRef.current = null
      setDragPreview(null)
      // No movement happened between touch-down and release — the native
      // SDK's draggable-symbol gesture only calls onDragStart at all after
      // its own internal long-press-to-engage recognizer fires (see
      // MLRNPointAnnotation.kt / SymbolManager), so reaching here with `d`
      // set already implies a deliberate hold, not an accidental tap — no
      // extra timing check needed. This is the "remove from route" gesture
      // (mirrors web's stationary-tap-in-adjust-mode → WpActionMenu).
      if (d) {
        onWaypointLongPress?.(d.wpIndex, d.lat, d.lng)
      }
      return
    }
    const wpIndex = d.wpIndex
    dragSeqRef.current++ // drop any in-flight move answers
    // The drop position is the lifted point, not where the finger lifted.
    const liftedPoint: [number, number] = [point[0], point[1] - DRAG_LIFT_PX]
    // dragPreview is intentionally NOT cleared yet — it keeps the route line
    // rendered at the drop point while the snap query below resolves
    // asynchronously. Clearing it here would flip the waypoint back to its
    // OLD position for a frame (route re-renders from the still-stale
    // `waypoints` prop) before onWaypointMove's result flips it forward again
    // — a visible flicker. Instead, dragPreview and the commit both clear/
    // apply together once the real answer is known.
    const commit = (wp: RouteWaypoint) => {
      dragPreviewRef.current = null
      setDragPreview(null)
      onWaypointMove?.(wpIndex, wp)
    }
    if (!mapRef.current) { commit({ lat: preview.lat, lng: preview.lng }); return }
    // Snap-on-release — mirrors web's commitDrag: query nearby snap targets
    // around the (lifted) drop point and resolve to an exact feature when
    // unambiguous, or hand candidates to the caller for a disambiguation
    // picker (position stays at the OLD waypoint location until the user
    // picks, same as web).
    const map = mapRef.current
    liftedLngLat(point, preview.lat, preview.lng).then(async (raw) => {
      const hits = await map.queryRenderedFeatures(
        [[liftedPoint[0] - SNAP_PX, liftedPoint[1] - SNAP_PX], [liftedPoint[0] + SNAP_PX, liftedPoint[1] + SNAP_PX]],
        { layers: SNAP_LAYERS },
      )
      return { raw, hits }
    })
      .then(({ raw, hits }) => {
        if (hits.length === 0) { commit(raw); return }
        // Always let the user choose — even a single nearby match shouldn't
        // auto-snap silently. buildSnapCandidates always appends a "drop at
        // exact location" entry alongside any real hits, so this list is
        // never just 1 long when hits.length > 0.
        const candidates = buildSnapCandidates(hits, raw)
        if (!onWaypointMoveCandidates) { commit(candidates[0]?.waypoint ?? raw); return }
        // Ambiguous — clear the preview now (falls back to the OLD position
        // while the picker is open) and let the caller's onPick eventually
        // call onWaypointMove with the chosen candidate, same as web.
        dragPreviewRef.current = null
        setDragPreview(null)
        onWaypointMoveCandidates(wpIndex, candidates)
      })
      .catch(() => commit({ lat: preview.lat, lng: preview.lng }))
  }, [onWaypointMove, onWaypointMoveCandidates, onWaypointLongPress, liftedLngLat])

  // Leg-midpoint drag-insert state — same native-ViewAnnotation-drag pattern
  // as waypoint move above, but commits via onLegInsert(Candidates) instead
  // (inserting a brand-new waypoint between legIndex/legIndex+1 rather than
  // moving an existing one). A live rubber-band preview line is drawn from
  // both adjacent waypoints to the current drag position (see
  // 'leg-insert-preview' source below) since — unlike a waypoint move —
  // there's no existing route point whose position updates automatically.
  const legDragRef = useRef<{ legIndex: number } | null>(null)
  const [legDragging, setLegDragging] = useState(false)
  const [legDragPreview, setLegDragPreview] = useState<{ legIndex: number; lat: number; lng: number } | null>(null)
  const legDragPreviewRef = useRef<{ legIndex: number; lat: number; lng: number } | null>(null)

  const startLegDrag = useCallback((legIndex: number) => {
    legDragRef.current = { legIndex }
    setLegDragging(true)
  }, [])
  const legDragSeqRef = useRef(0)
  const moveLegDrag = useCallback((lat: number, lng: number, point: [number, number]) => {
    const d = legDragRef.current
    if (!d) return
    const seq = ++legDragSeqRef.current
    liftedLngLat(point, lat, lng).then((lifted) => {
      if (seq !== legDragSeqRef.current || legDragRef.current !== d) return
      const next = { legIndex: d.legIndex, lat: lifted.lat, lng: lifted.lng }
      legDragPreviewRef.current = next
      setLegDragPreview(next)
    })
  }, [liftedLngLat])
  const releaseLegDrag = useCallback((point: [number, number]) => {
    const d = legDragRef.current
    const preview = legDragPreviewRef.current
    legDragRef.current = null
    legDragPreviewRef.current = null
    setLegDragging(false)
    setLegDragPreview(null)
    suppressNextPressRef.current = true
    if (!d || !preview) return
    const legIndex = d.legIndex
    legDragSeqRef.current++
    const fallbackRaw: RouteWaypoint = { lat: preview.lat, lng: preview.lng }
    if (!mapRef.current) { onLegInsert?.(legIndex, fallbackRaw); return }
    // Snap around the lifted drop point (see DRAG_LIFT_PX), from the drag-end
    // event's own screen-pixel point.
    const map = mapRef.current
    const liftedPoint: [number, number] = [point[0], point[1] - DRAG_LIFT_PX]
    liftedLngLat(point, preview.lat, preview.lng).then(async (raw) => {
      const hits = await map.queryRenderedFeatures(
        [[liftedPoint[0] - SNAP_PX, liftedPoint[1] - SNAP_PX], [liftedPoint[0] + SNAP_PX, liftedPoint[1] + SNAP_PX]],
        { layers: SNAP_LAYERS },
      )
      return { raw, hits }
    })
      .then(({ raw, hits }) => {
        if (hits.length === 0) { onLegInsert?.(legIndex, raw); return }
        const candidates = buildSnapCandidates(hits, raw)
        if (!onLegInsertCandidates) { onLegInsert?.(legIndex, candidates[0]?.waypoint ?? raw); return }
        onLegInsertCandidates(legIndex, candidates)
      })
      .catch(() => onLegInsert?.(legIndex, fallbackRaw))
  }, [onLegInsert, onLegInsertCandidates, liftedLngLat])

  // Fly to home airfield once when initialCenter first resolves (async ICAO lookup)
  const homeCenteredRef = useRef(false)
  useEffect(() => {
    if (!initialCenter || homeCenteredRef.current) return
    homeCenteredRef.current = true
    cameraRef.current?.flyTo({
      center: initialCenter as [number, number],
      zoom:   initialZoom ?? 11,
      duration: 800,
    })
  }, [initialCenter, initialZoom])

  // Fly to a Find-a-Destination row tap.
  useEffect(() => {
    if (!flyToTarget) return
    cameraRef.current?.flyTo({
      center: [flyToTarget.lng, flyToTarget.lat],
      zoom:   flyToTarget.zoom ?? 13,
      duration: 1400,
    })
  }, [flyToTarget])

  // Fit camera to a viewed flight log's track bounds whenever it's selected
  // (or changes) — Logs segment "View" action on PlanScreen.
  useEffect(() => {
    if (!pastTrack || pastTrack.length < 2) return
    const lngs = pastTrack.map(p => p[0])
    const lats = pastTrack.map(p => p[1])
    cameraRef.current?.fitBounds(
      [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
      { padding: { top: 60, bottom: 60, left: 60, right: 60 }, duration: 600 },
    )
  }, [pastTrack])

  // Fit camera to the route's bounds right after it's loaded/activated —
  // RouteLibrarySheet's handleLoad (Flight Plan tab) changes activeRouteId,
  // which this screen doesn't otherwise have a map-camera reaction to since
  // the library sheet lives on a separate tab from the map. Skips the very
  // first invocation (component mount / cold-start restore of the last
  // session's linked route) via routeFitMountedRef — that case already gets
  // its own flyTo from the home-airfield/initialCenter effect above, and
  // firing this one too would be two competing camera moves on first paint.
  // Deliberately keyed on activeRouteId, not `waypoints` itself, so this
  // does NOT re-fit on every incremental tap-to-add-a-waypoint edit during
  // ordinary planning (which leaves activeRouteId untouched).
  const fitRoute = useCallback((wps: RouteWaypoint[]) => {
    if (wps.length < 2) return
    const lngs = wps.map(w => w.lng)
    const lats = wps.map(w => w.lat)
    cameraRef.current?.fitBounds(
      [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
      { padding: { top: 100, bottom: 100, left: 80, right: 120 }, duration: 800 },
    )
  }, [])
  // Route loaded / re-activated (nonce) or linked route changed.
  const waypointsRef = useRef(waypoints)
  waypointsRef.current = waypoints
  const fitSeenRef = useRef({ nonce: routeFitNonce, id: activeRouteId })
  useEffect(() => {
    const seen = fitSeenRef.current
    if (seen.nonce === routeFitNonce && seen.id === activeRouteId) return
    fitSeenRef.current = { nonce: routeFitNonce, id: activeRouteId }
    homeCenteredRef.current = true
    fitRoute(waypointsRef.current ?? [])
  }, [routeFitNonce, activeRouteId, fitRoute])
  // Map opened with a route already in place (cold start restore, or the map
  // mounted after the route was loaded): fit once as soon as it has 2+ points.
  const initialFitDoneRef = useRef(false)
  useEffect(() => {
    // Wait for the first full render: fitBounds before the map has a size
    // computes a wrong (far too wide) zoom.
    if (readyStage < 1 || initialFitDoneRef.current || !waypoints || waypoints.length < 2) return
    initialFitDoneRef.current = true
    homeCenteredRef.current = true
    fitRoute(waypoints)
  }, [waypoints, fitRoute, readyStage])

  // Fly to the first live position fix (GPS or simulator) — independent of
  // home-airfield centering. A fresh sim/GPS fix can be anywhere on Earth
  // (e.g. X-Plane's default airport), far from both DEFAULT_CENTER and the
  // home airfield, and would otherwise render off-screen with zero feedback
  // that data is flowing. Always wins the most recent flyTo on first fix.
  //
  // Also re-fires when simActive flips false→true: device GPS may already
  // have consumed the one-shot fly-to before the simulator connects, so
  // switching position source needs its own fly-to — otherwise the camera
  // stays anchored on the device's real location while the aircraft dot
  // silently jumps to the simulator's position off-screen.
  const posCenteredRef = useRef(false)
  const prevSimActiveRef = useRef(false)
  useEffect(() => {
    const simJustActivated = simActive && !prevSimActiveRef.current
    prevSimActiveRef.current = simActive
    if (!gpsPosition) return
    if (posCenteredRef.current && !simJustActivated) return
    posCenteredRef.current = true
    // A route already in view (fitted on open/load) takes priority over the
    // first passive fix; the sim/live flight modes still centre on the aircraft.
    if (!simJustActivated && !followGps && (waypointsRef.current?.length ?? 0) >= 2) return
    cameraRef.current?.flyTo({
      center:   [gpsPosition.lng, gpsPosition.lat],
      zoom:     11,
      duration: 800,
    })
  }, [gpsPosition, simActive])

  useEffect(() => {
    if (!followGps || !gpsPosition) return
    const heading = mapOrientation === 'track' ? gpsPosition.trackDeg : 0
    // duration MUST be <= the position-source's own update cadence (sim's
    // SimFlightEngine ticks at 5 Hz / TICK_MS=200 -- see that file). This
    // effect re-issues easeTo on every single gpsPosition change, so a
    // duration longer than the tick interval (previously 300ms) meant each
    // new easeTo restarted/interrupted the still-animating previous one
    // before it finished -- a self-fighting camera stutter that, under a
    // JS-thread hiccup (GC pause, awaited fetch resolving, etc.) backlogs a
    // burst of onRegionIsChanging callbacks into a single flush and can trip
    // React's synchronous update-depth guard (reproduced in practice: fires
    // every ~15s during hands-off sim flight, no user panning involved).
    // 200ms lets each animation fully settle right as the next tick's data
    // arrives -- smooth follow with no overlapping/self-interrupting easeTo.
    cameraRef.current?.easeTo({
      center:   [gpsPosition.lng, gpsPosition.lat],
      bearing:  heading,
      duration: 200,
    })
  }, [followGps, gpsPosition, mapOrientation])

  // Restore north-up when stopping -- but not when followGps just dropped
  // out because the pilot manually panned/rotated the map (onUserPan): in
  // that case they're actively dragging and mid-gesture, so snapping
  // bearing back to 0 here would fight their own touch instead of just
  // leaving the camera exactly where they put it.
  useEffect(() => {
    if (!followGps) {
      if (disabledByPanRef.current) { disabledByPanRef.current = false; return }
      const { lng, lat } = camStateRef.current
      cameraRef.current?.easeTo({ center: [lng, lat], bearing: 0, duration: 500 })
    }
  }, [followGps])

  // Auto-zoom: idle → 30 kts → zoom 13 (takeoff) → 60 kts → zoom 11 (cruise)
  const autoZoomPhaseRef = useRef<'idle' | 'takeoff' | 'cruise'>('idle')
  useEffect(() => { if (!followGps) autoZoomPhaseRef.current = 'idle' }, [followGps])
  useEffect(() => {
    if (!autoZoom || !followGps || !gpsPosition) return
    const spd   = gpsPosition.speedKts
    const phase = autoZoomPhaseRef.current
    // Center on gpsPosition (the aircraft), NOT camStateRef.current -- this
    // effect runs in the same commit as the plain followGps recenter effect
    // above whenever the pilot re-enables follow (e.g. the recenter button)
    // after having panned away. camStateRef is only updated asynchronously
    // by the native map's own onRegionDidChange/onRegionIsChanging events,
    // so right after re-enabling it's still the stale panned-to location --
    // using it here fought the recenter effect's aircraft-centered easeTo
    // with a second, longer (1500/2000ms) one back toward where the pilot
    // had panned, at a new zoom. Symptom: recenter looked like it needed a
    // second press to actually land on the aircraft.
    if (phase === 'idle' && spd >= 30) {
      autoZoomPhaseRef.current = 'takeoff'
      cameraRef.current?.easeTo({ center: [gpsPosition.lng, gpsPosition.lat], zoom: 13, duration: 1500 })
    } else if (phase === 'takeoff' && spd >= 60) {
      autoZoomPhaseRef.current = 'cruise'
      cameraRef.current?.easeTo({ center: [gpsPosition.lng, gpsPosition.lat], zoom: 11, duration: 2000 })
    }
  }, [autoZoom, followGps, gpsPosition])

  const ceilingFilter = ['<=', ['get', 'lower_ft'], airspaceCeilingFt]

  // Per-class filters combined with ceiling
  const mkFilter = (classExpr: unknown[]) => ['all', ceilingFilter, classExpr] as unknown[]
  const isDanger         = ['all', ['==', ['get', 'class'], 'D'], ['==', ['get', 'type'], 'D']]
  const filterZones      = mkFilter(['in', ['get', 'type'], ['literal', [...ZONE_TYPES]]])
  const filterRestricted = mkFilter(['any', ['in', ['get', 'class'], ['literal', ['R', 'TRA']]], isDanger])
  const filterRed        = mkFilter(['any', ['==', ['get', 'class'], 'R'], isDanger])
  const filterActivity   = mkFilter(['in', ['get', 'class'], ['literal', ['GLDR', 'MODEL']]])

  // One static-colour layer set per airspace sub-class. iOS aborts at style
  // load when a colour property carries a data-driven expression on a GeoJSON
  // layer (uncaught exception in MLRNStyle set*Color), so colours are never
  // computed from feature properties here; the filter picks the sub-class.
  const subClass = (f: unknown[], c: string) => ['all', f, ['==', ['get', 'class'], c]]
  type AsParams = { inset: { w: number; off: number; op: number }; bdr: { w: number; dash?: number[] }; label: { size: number; field: unknown } }
  const AS_PARAMS: Record<'ctr' | 'tma' | 'g' | 'r' | 'dng' | 'act', AsParams> = {
    ctr: { inset: { w: 6, off: 3,   op: 0.22 }, bdr: { w: 1.5, dash: [4, 3] }, label: { size: 10, field: AIRSPACE_LABEL_TEXT_FIELD } },
    tma: { inset: { w: 10, off: 5,  op: 0.28 }, bdr: { w: 1.5, dash: [4, 3] }, label: { size: 10, field: AIRSPACE_LABEL_TEXT_FIELD } },
    g:   { inset: { w: 0, off: 0,   op: 0 },    bdr: { w: 1.0, dash: [2, 2] }, label: { size: 9,  field: AIRSPACE_ZONE_LABEL_TEXT_FIELD } },
    r:   { inset: { w: 6, off: 3,   op: 0.24 }, bdr: { w: 1.8 },               label: { size: 10, field: AIRSPACE_RESTRICTED_LABEL_TEXT_FIELD } },
    dng: { inset: { w: 6, off: 3,   op: 0.24 }, bdr: { w: 1.8, dash: [4, 3] }, label: { size: 10, field: AIRSPACE_RESTRICTED_LABEL_TEXT_FIELD } },
    act: { inset: { w: 5, off: 2.5, op: 0.16 }, bdr: { w: 1.0, dash: [3, 2] }, label: { size: 9,  field: AIRSPACE_LABEL_TEXT_FIELD } },
  }
  // Controlled airspace (ICAO classes A-F) x kind (CTR / TMA+CTA): one static-colour
  // layer set each. Class G is never drawn; RMZ/ATZ/TMZ have the 'g' zone variant,
  // danger areas the red restricted variants.
  const NON_CONTROLLED_TYPES = [...ZONE_TYPES, 'FIR', 'UIR', 'D']
  const controlledVariants = CONTROLLED_CLASSES.flatMap((cls) =>
    (['ctr', 'tma'] as const).map((kind) => {
      const st = controlledStyle(cls, kind === 'ctr' ? 'CTR' : 'TMA')
      return {
        k: `${cls.toLowerCase()}-${kind}`,
        f: ['all', mkFilter(['==', ['get', 'class'], cls]), kind === 'ctr'
          ? ['==', ['get', 'type'], 'CTR']
          : ['all', ['!=', ['get', 'type'], 'CTR'], ['!', ['in', ['get', 'type'], ['literal', NON_CONTROLLED_TYPES]]]]] as unknown[],
        col: st.border, fill: st.mapFill, kind, band: st.band, width: st.width,
        show: kind === 'ctr' ? showClassCtr : showClassCtma,
        p: AS_PARAMS[kind],
      }
    }))
  const asVariants: { k: string; f: unknown[]; col: string; fill?: string; kind?: 'ctr' | 'tma'; band?: number; width?: number; show: boolean; p: AsParams }[] = [
    ...controlledVariants,
    { k: 'g', f: filterZones, col: AC.gBorder, fill: 'rgba(120, 120, 120, 0.01)', show: showClassG, p: AS_PARAMS.g },
    { k: 'r',     f: subClass(filterRestricted, 'R'),                   col: AC.rBorder,     show: showRestricted, p: AS_PARAMS.r },
    { k: 'dng',   f: mkFilter(isDanger),                                col: AC.rBorder,     show: showRestricted, p: AS_PARAMS.dng },
    { k: 'tra',   f: subClass(filterRestricted, 'TRA'),                 col: AC.traBorder,   show: showRestricted, p: AS_PARAMS.r },
    { k: 'gldr',  f: subClass(filterActivity, 'GLDR'),                  col: AC.gldrBorder,  show: showActivity,   p: AS_PARAMS.act },
    { k: 'model', f: subClass(filterActivity, 'MODEL'),                 col: AC.modelBorder, show: showActivity,   p: AS_PARAMS.act },
  ]

  const handleMapPress = useCallback(
    (e: NativeSyntheticEvent<PressEvent | PressEventWithFeatures>) => {
      if (suppressNextPressRef.current) {
        suppressNextPressRef.current = false
        return
      }
      const payload = e.nativeEvent

      // ── Planning mode — every tap adds a waypoint, snapped to a nearby
      // feature within a screen-pixel radius when unambiguous (mirrors web's
      // MapView.tsx planning-mode click handler). ─────────────────────────
      if (rulerMode) {
        const lngLat = (payload as PressEvent).lngLat
        if (!lngLat) return
        const pt: RouteWaypoint = { lng: lngLat[0], lat: lngLat[1] }
        const prev = rulerPoints ?? []
        const next = prev.length < 2 ? [...prev, pt] : [prev[1], pt]
        onRulerTap?.(next)
        return
      }

      if (planningMode) {
        const lngLat = (payload as PressEvent).lngLat
        const point  = (payload as PressEvent).point
        if (!lngLat || !point || !mapRef.current) return
        const SNAP_PX_LOCAL = SNAP_PX
        Promise.all([
          mapRef.current.queryRenderedFeatures(
            [[point[0] - SNAP_PX_LOCAL, point[1] - SNAP_PX_LOCAL], [point[0] + SNAP_PX_LOCAL, point[1] + SNAP_PX_LOCAL]],
            { layers: ['route-legs-hit'] },
          ),
          mapRef.current.queryRenderedFeatures(
            [[point[0] - SNAP_PX_LOCAL, point[1] - SNAP_PX_LOCAL], [point[0] + SNAP_PX_LOCAL, point[1] + SNAP_PX_LOCAL]],
            { layers: SNAP_LAYERS },
          ),
        ])
          .then(([legHits, hits]) => {
            // Leg hit takes priority over snap/append — insert waypoint
            // mid-route instead of appending at end (mirrors web's
            // MapView.tsx planning-mode click handler).
            const legHit = legHits[0]
            if (legHit && onLegTap) {
              onLegTap(legHit.properties?.legIndex as number, { lat: lngLat[1], lng: lngLat[0] })
              return
            }
            if (hits.length === 0) {
              onPlanTap?.({ lng: lngLat[0], lat: lngLat[1] })
              return
            }
            const raw = { lng: lngLat[0], lat: lngLat[1] }
            const candidates = buildSnapCandidates(hits, raw)
            if (!onPlanCandidates) {
              onPlanTap?.(candidates[0]?.waypoint ?? raw)
              return
            }
            onPlanCandidates(candidates, point)
          })
          .catch(() => onPlanTap?.({ lng: lngLat[0], lat: lngLat[1] }))
        return
      }

      if (!('features' in payload) || payload.features.length === 0) return
      const fs = payload.features as Feature[]
      const f  = fs[0]
      const p  = f.properties ?? {}

      // Extract tap coordinates from the event
      const ll = (payload as PressEventWithFeatures).lngLat
      const tapLngLat: [number, number] = [ll[0], ll[1]]

      // NOTAM point cluster -- expand zoom instead of opening a popup.
      // Handled entirely here (not forwarded to onFeatureTap) since it needs
      // notamPointsSourceRef + cameraRef, both local to this component.
      if (p.cluster_id !== undefined) {
        const clusterId = p.cluster_id as number
        notamPointsSourceRef.current?.getClusterExpansionZoom(clusterId)
          .then((zoom) => {
            cameraRef.current?.easeTo({ center: tapLngLat, zoom, duration: 300 })
          })
          .catch(() => { /* best-effort -- leave camera where it is */ })
        return
      }

      // Leg tap — insert waypoint after this leg
      if (p.featureType === 'leg' && onLegTap) {
        onLegTap(p.legIndex as number, { lat: tapLngLat[1], lng: tapLngLat[0] })
        return
      }

      // Double-tap a route waypoint — remove it from the route (see
      // onWaypointRemove doc comment). Tracked here rather than on
      // WaypointDragAnnotation itself since a still tap never reaches its
      // touch-down at all — same reason its long-press equivalent had to
      // move to handleMapLongPress's feature query.
      if (p.featureType === 'wp' && onWaypointRemove) {
        const wpIndex = p.wpIndex as number
        const now = Date.now()
        const last = lastWpTapRef.current
        if (last && last.wpIndex === wpIndex && now - last.time < DOUBLE_TAP_MS) {
          lastWpTapRef.current = null
          onWaypointRemove(wpIndex)
          return
        }
        lastWpTapRef.current = { wpIndex, time: now }
      }

      onFeatureTap?.(fs, tapLngLat)
    },
    [onFeatureTap, onLegTap, planningMode, onPlanTap, onPlanCandidates, onWaypointMove, onWaypointRemove, rulerMode, rulerPoints, onRulerTap],
  )

  const handleMapLongPress = useCallback(
    (e: NativeSyntheticEvent<PressEvent | PressEventWithFeatures>) => {
      if (suppressNextPressRef.current) {
        suppressNextPressRef.current = false
        return
      }
      const payload = e.nativeEvent
      const { lngLat, point } = payload as PressEvent
      const [lng, lat] = lngLat
      // A long-press held perfectly still directly over a route waypoint
      // circle (or leg-midpoint drag handle / route line) never engages the
      // native ViewAnnotation drag gesture at all (that only claims the touch
      // once actual finger movement is detected), so it falls straight
      // through to this generic map long-press instead of
      // WaypointDragAnnotation's/LegMidpointAnnotation's own onDragStart/
      // onDragEnd. Check for a route-pts-circle hit first (→
      // onWaypointLongPress / Remove-from-Route menu), then a route-legs-hit
      // hit (→ suppressed entirely — "Add to Route" makes no sense on a
      // point already part of the route, and there's no long-press action
      // defined for a leg yet), and only fall back to the bare-point
      // Add-to-Route/Save-Waypoint menu when neither matches.
      if (mapRef.current && (onWaypointLongPress || onLegTap)) {
        Promise.all([
          mapRef.current.queryRenderedFeatures(
            [[point[0] - SNAP_PX, point[1] - SNAP_PX], [point[0] + SNAP_PX, point[1] + SNAP_PX]],
            { layers: ['route-pts-circle'] },
          ),
          mapRef.current.queryRenderedFeatures(
            [[point[0] - SNAP_PX, point[1] - SNAP_PX], [point[0] + SNAP_PX, point[1] + SNAP_PX]],
            { layers: ['route-legs-hit'] },
          ),
        ]).then(([wpHits, legHits]) => {
          const wpIndex = wpHits[0]?.properties?.wpIndex
          if (typeof wpIndex === 'number' && onWaypointLongPress) {
            onWaypointLongPress(wpIndex, lat, lng)
            return
          }
          if (legHits.length > 0) return
          if (onLongPress) {
            onLongPress({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} })
          }
        }).catch(() => {
          if (onLongPress) onLongPress({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} })
        })
        return
      }
      if (!onLongPress) return
      onLongPress({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} })
    },
    [onLongPress, onWaypointMove, onWaypointLongPress, onLegTap],
  )

  // While a point is being dragged the route is drawn twice: the original
  // (faded ghost) and the route as it would be after the drop (new colour).
  const routeDragActive = (dragging && !!dragPreview) || (legDragging && !!legDragPreview)
  const routeLegs   = routeLegsGeoJSON(legDragging ? withInserted(waypoints, legDragPreview) : waypoints, dragPreview)
  const ghostLegs   = routeDragActive ? routeLegsGeoJSON(waypoints) : null
  const dropPoint   = dragPreview ?? legDragPreview
  const dropPointFC: FeatureCollection | null = routeDragActive && dropPoint
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [dropPoint.lng, dropPoint.lat] }, properties: {} }] }
    : null
  const routePoints = routePointsGeoJSON(waypoints, dragPreview)
  // Leg-midpoint drag handles must track a waypoint's live drag position too
  // — otherwise the handle for a leg touching the waypoint being dragged
  // stays planted at the stale pre-drag midpoint, showing as a stray extra
  // marker near (not on) the actively-dragged waypoint.
  const legMidpointWps = withPreview(waypoints, dragPreview)
  const aircraftFC  = gpsPosition && showAircraft ? aircraftGeoJSON(gpsPosition) : null

  // Trajectory: main line + 3 perpendicular tick marks (matches web)
  const trajectoryFC: FeatureCollection = useMemo(() => {
    if (!gpsPosition || gpsPosition.speedKts < 5) {
      return { type: 'FeatureCollection', features: [] }
    }
    const { lat, lng, speedKts, trackDeg } = gpsPosition
    const spd  = speedKts
    // Mark distances in NM
    const marks = trajectoryMode === 'time'
      ? [1, 3, trajectoryNm].map(min => (min / 60) * spd)
      : [1, 3, trajectoryNm]
    const tip     = advancePosition(lat, lng, trackDeg, marks[2])
    const perpBrg = (trackDeg + 90) % 360
    const TICK_WIDTHS = [0.08, 0.11, 0.14]  // half-width NM per tick
    const ticks = marks.map((distNm, i) => {
      const c     = advancePosition(lat, lng, trackDeg, distNm)
      const half  = TICK_WIDTHS[i]
      const left  = advancePosition(c.lat, c.lng, (perpBrg + 180) % 360, half)
      const right = advancePosition(c.lat, c.lng, perpBrg, half)
      return {
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: [[left.lng, left.lat], [right.lng, right.lat]] },
        properties: { type: 'tick' },
      }
    })
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature' as const,
          geometry: { type: 'LineString' as const, coordinates: [[lng, lat], [tip.lng, tip.lat]] },
          properties: { type: 'line' },
        },
        ...ticks,
      ],
    }
  }, [gpsPosition, trajectoryNm, trajectoryMode])

  return (
    <View
      style={StyleSheet.absoluteFill}
    >
      <Map
        key={mapRetryKey}
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        onRegionDidChange={handleRegionChange}
        onRegionIsChanging={handleRegionChange}
        mapStyle={basemapMode === 'satellite' ? SATELLITE_STYLE as any : getProtomapsStyle() as any}
        onPress={handleMapPress}
        onLongPress={handleMapLongPress}
        // See handleMapLoadFailure / styleLoaded doc comment above (landuse
        // mount-timing + OOM-triggered blank-basemap fix).
        onDidFinishLoadingStyle={() => setStyleLoaded(true)}
        onDidFailLoadingMap={handleMapLoadFailure}
        // Drives the readyStage settle-detection above -- see that state's
        // doc comment (structural fix for the landuse/hillshade/contours
        // startup-mount race).
        onDidFinishRenderingMapFully={handleDidFinishRenderingMapFully}
        // Only needs to guard against the (now rare) case where the touch
        // grab in the overlay above didn't win the arena in time.
        dragPan={!dragging}
        logo={false}
        // Native attribution dialog disabled -- replaced by the custom
        // button/Modal below. See showAttribution state doc comment above.
        attribution={false}
        compass={true}
        compassPosition={{ top: 8, right: 8 }}
      >
        {showOwnPosition && <UserLocation accuracy heading minDisplacement={5} />}
        <Camera
          ref={cameraRef}
          // Preserve camera position across an auto-retry remount (key bump
          // above) instead of snapping back to DEFAULT_CENTER -- camStateRef
          // holds the last known position/zoom from onRegionDidChange, still
          // at its init default (Sweden-wide view) on a genuine first mount.
          initialViewState={{
            center: [camStateRef.current.lng, camStateRef.current.lat],
            zoom: camStateRef.current.zoom,
          }}
        />

        {/* ── Landuse (farmland/residential/wetland) — static PMTiles ──────── */}
        {/* Retired from Postgres/Martin, same pattern as basemap.pmtiles — see
            apps/web/src/styles/map-style.ts getLanduseSource() and
            docs/self-hosting.md. Matches web landuse-fill layer. Renders
            below all aviation overlays. Lazy-mounted -- see landuseMounted
            comment above; only pays its ~87MB source cost once showLanduse
            has been true at least once this session (true by default). */}
        {landuseMounted && (
        <VectorSource
          id="osm-landuse"
          url={landusePmtilesUrl}
          maxzoom={12}
          // Attribution parity with web's getLanduseSource() (map-style.ts) —
          // MapLibre Native's (i) attribution dialog only lists what each
          // mounted source declares; without this the dialog was silently
          // missing the OSM/ODbL credit that's required and shown on web.
          attribution='© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors (ODbL)'
        >
          {LANDUSE_FILLS.map(lu => (
            <Layer
              key={lu.k}
              id={`landuse-fill-${lu.k}`}
              filter={['==', ['get', 'kind'], lu.kind] as any}
              type="fill"
              source="osm-landuse"
              {...{'source-layer': 'landuse'} as any}
              // BUG FIX (found live on device): MapLibre React Native inserts
              // JSX-declared <Layer> children ABOVE every existing style layer
              // by default (append-only, no implicit position), unlike web's
              // map-style.ts where landuse-fill's position in the raw style
              // JSON array is explicitly chosen (fills before labels). Without
              // beforeId this fill layer rendered on top of the basemap's own
              // place/label text (city names like "Gislaved" became unreadable
              // when landuse was on) -- confirmed NOT reproducible on web,
              // native-only bug. 'address_label' is the FIRST symbol/label
              // layer in protomaps-themes-base's layers() output (verified via
              // node -e against the actual installed @protomaps/basemaps
              // package) -- beforeId places landuse-fill immediately below it,
              // i.e. below every text label, matching web's fill-before-labels
              // z-order exactly.
              beforeId="address_label"
              layout={{ visibility: showLanduse ? 'visible' : 'none' }}
              paint={{
                'fill-color': lu.col,
                'fill-opacity': 0.85,
              }}
            />
          ))}
        </VectorSource>
        )}

        {/* Hillshade (relief shading) -- self-hosted Copernicus GLO-30 DEM,
            Terrarium-encoded raster-dem PMTiles from R2, same source
            getHillshadeSource() uses on web (map-style.ts). Verified
            supported on both platforms at the native binary level (Android:
            MLRNLayer.kt -> HillshadeLayer / org.maplibre.android.style.layers;
            iOS: MLRNLayer.m -> MLNHillshadeStyleLayer) -- see AGENTS.md. Off
            by default; toggled via layout.visibility like every other layer
            here, never unmounted (MapLibre Native throws 'id cannot be
            changed' otherwise). Rendered below landuse-fill and all
            aviation overlays. Lazy-mounted -- see hillshadeMounted comment
            above; ~681MB source, only pays that cost once hillshade or
            terrain-color has actually been turned on this session. */}
        {hillshadeMounted && (
        <RasterDEMSource
          id="osm-hillshade"
          url={hillshadePmtilesUrl}
          encoding="terrarium"
          // Attribution parity with web's getHillshadeSource() — Copernicus
          // DEM license requires citing the dataset DOI. See osm-landuse's
          // attribution comment above for why this must be set here too.
          attribution="Copernicus DEM GLO-30 \u2014 \u00a9 ESA / European Union, doi:10.5270/ESA-c5d3d65"
          // Must match the archive's REAL base zoom (10), not a desired
          // one -- mirrors getHillshadeSource()'s maxzoom in web's
          // map-style.ts (see its detailed comment). dem_mosaic.sh's
          // ~90m/px downsampled input raster's base (finest) zoom lands
          // at z10; there is no z11/z12 data in this file, only coarser
          // gdaladdo overview zooms below it. A declared maxzoom of 12
          // (as this was) doesn't error -- MapLibre Native overzooms by
          // upsampling the real z10 tile and treating it as if it were
          // native z11/z12 resolution, which recomputes the hillshade
          // slope algorithm's horizontal distance-per-pixel far too small
          // for the *same* real elevation delta, producing grossly
          // exaggerated relief ('huge mountains' rendered even over
          // genuinely flat terrain like Skåne). Confirmed as the root
          // cause on a real device; web's JS SDK fails differently for
          // the identical over-declared-maxzoom mistake (tiles hang in
          // 'loading' state forever instead of rendering wrong) which is
          // why that fix predates this one.
          maxzoom={10}
        >
          <Layer
            id="hillshade"
            type="hillshade"
            source="osm-hillshade"
            // BUG FIX (overzoom blockiness at the border, mirrors web's
            // map-style.ts fix): the source above is already capped at its
            // real maxzoom=10 (~90m/px), but MapLibre Native still overzooms
            // (upscales) that tile above z10 for rendering -- each real data
            // pixel then covers more screen pixels the further in you zoom,
            // most visible as a blocky/stairstepped dark band tracing the
            // country-border alpha cutoff. This layer-level maxzoom stops
            // the LAYER from rendering at all beyond z11 (distinct from the
            // source maxzoom above, which only bounds tile fetch/overzoom).
            maxzoom={11}
            layout={{ visibility: showHillshade ? 'visible' : 'none' }}
            paint={{
              // MUCH lower than web's 0.5 (map-style.ts) -- confirmed via a
              // real-device A/B test that MapLibre Native's Android
              // hillshade renderer is far more sensitive to this value
              // than the JS SDK: web's own comment notes 0.5 was barely
              // visible even over genuinely steep, snow-capped Kiruna
              // fjell terrain, whereas 0.5 on native rendered dramatic,
              // unrealistic mountain-ridge relief even over flat Skåne
              // farmland (near-zero real elevation variation). Same
              // underlying Terrarium-encoded DEM data on both platforms
              // (round-trip verified at the pipeline level, see
              // hillshade_to_pmtiles.sh) -- this is a genuine rendering-
              // engine difference, not a data or maxzoom bug (that fix
              // above was real and necessary, but didn't address this).
              // Revisit if a maplibre-react-native/MapLibre Native update
              // changes this sensitivity. Goal is visual parity with web's
              // actual rendered look (near-invisible over flat terrain,
              // subtle even over real mountains at 0.5), not just "less bad"
              // -- 0.15 was still visibly too strong per live device testing
              // over southern Sweden (Skåne, genuinely flat). Dropped much
              // further to 0.02.
              'hillshade-exaggeration': 0.02,
              // hillshade-shadow-color/highlight-color intentionally NOT
              // set (library default used instead) -- confirmed against
              // the installed @maplibre/maplibre-react-native 11.3.10
              // Android source (MLRNStyleFactory.kt):
              // setHillshadeShadowColor/HighlightColor's literal-string
              // branch calls getStringArray() on a plain color string and
              // throws UnexpectedNativeTypeException (Double cannot be
              // cast to ReadableArray), crashing on every map mount
              // regardless of whether hillshade is visible. Passing an
              // ['rgba', r, g, b, a] expression instead avoids the crash
              // (routes into the isExpression() branch) but Mbgl's JNI
              // layer then logs "Expected array<color> but found color
              // instead" and silently doesn't apply it for these two
              // properties specifically -- accent-color (below) is the
              // only one of the three that actually accepts the same
              // expression form correctly on this library version. Revisit
              // if a maplibre-react-native update fixes the Android bridge.
              'hillshade-accent-color': ['rgba', 60, 50, 40, 0.3],
            }}
          />

          {/* EXPERIMENTAL -- terrain colour-relief (red/orange/yellow/green
              clearance bands), web equivalent of terrain-color in map-style.ts
              + src/utils/terrainColor.ts. Shares this same osm-hillshade
              raster-dem source. color-relief has a documented GPU/Adreno
              rendering bug (RGBA32F texture format, not mandatory in the
              Vulkan spec) -- off by default, exists specifically so this can
              be checked on real hardware. If colours render wrong (all-brown,
              or stuck on one colour in the ramp) on a given device, that
              confirms the bug and this should stay disabled for that
              device/chipset until MapLibre Native ships a fix. */}
          <Layer
            id="terrain-color"
            type="color-relief"
            source="osm-hillshade"
            layout={{ visibility: showTerrainColor ? 'visible' : 'none' }}
            paint={{
              'color-relief-color': buildTerrainColorExpr(
                gpsPosition && gpsPosition.altFt > 0 ? gpsPosition.altFt : terrainColorRefAltFt,
              ) as any,
            }}
          />
        </RasterDEMSource>
        )}
        {/* Water cover for hillshade -- mirrors web's 'hillshade-water-cover'
            in map-style.ts. The DEM ships with no alpha/NoData (MapLibre
            Native decodes DEM tiles premultiplied and the hillshade shader
            discards alpha, so any transparent pixel is a -32768 m cliff at
            the coast); the pipeline continues terrain smoothly out to sea
            instead, and this fill paints basemap water back over it. Same
            source-layer/filter/colour as the Protomaps 'water' layer.
            References the style's own 'protomaps' source, so it lives
            outside the RasterDEMSource above. Gated on the same sticky
            hillshadeMounted flag (never unmount a layer once added -- 'id
            cannot be changed'); visibility tied to showHillshade. Vector
            basemap only (satellite style has no 'protomaps' source). */}
        {hillshadeMounted && basemapMode !== 'satellite' && (
          <Layer
            id="hillshade-water-cover"
            type="fill"
            source="protomaps"
            {...{'source-layer': 'water'} as any}
            filter={['==', '$type', 'Polygon'] as any}
            maxzoom={11}
            layout={{ visibility: showHillshade ? 'visible' : 'none' }}
            paint={{ 'fill-color': LIGHT.water }}
          />
        )}

        {/* ── Elevation contour lines (Copernicus GLO-30 DEM, vector) ─────
            Web equivalent: getContoursSource() + 'contour-line'/'contour-label'
            layers in map-style.ts. Same source-layer ('contours') and
            elev_m numeric property. Tiled at -Z6 -z12 (scripts/contours_to_
            pmtiles.sh) -- minzoom/maxzoom below must match the script's
            real -z value exactly, same maxzoom-mismatch bug class as
            hillshade above (see its comment): a vector source degrades
            less catastrophically than raster-dem for a wrong declared
            maxzoom (a fetch to a non-existent tile just empty-tiles rather
            than rendering garbage), but there's no reason to leave it
            wrong. Line width/color widened+darkened to match web's own
            verified-live fix (the original faint styling was invisible in
            practice over real Kiruna-fjell contour data). Off by default;
            toggled via layout.visibility. Lazy-mounted -- see contoursMounted
            comment above; ~234MB source, only pays that cost once contours
            has actually been turned on this session. */}
        {contoursMounted && (
        <VectorSource
          id="osm-contours"
          url={contoursPmtilesUrl}
          minzoom={6}
          maxzoom={12}
          // Attribution parity with web's getContoursSource() — same
          // Copernicus DEM source as osm-hillshade above.
          attribution="Copernicus DEM GLO-30 \u2014 \u00a9 ESA / European Union, doi:10.5270/ESA-c5d3d65"
        >
          <Layer
            id="contour-line"
            type="line"
            source="osm-contours"
            {...{'source-layer': 'contours'} as any}
            minzoom={8}
            layout={{ visibility: showContours ? 'visible' : 'none', 'line-join': 'round' }}
            paint={{
              'line-color': 'rgba(120,80,35,0.85)',
              // Index contours (multiples of 250m) drawn wider than intermediate ones.
              'line-width': ['case', ['==', ['%', ['round', ['get', 'elev_m']], 250], 0], 2.2, 1.1],
            }}
          />
          <Layer
            id="contour-label"
            type="symbol"
            source="osm-contours"
            {...{'source-layer': 'contours'} as any}
            minzoom={10}
            filter={['==', ['%', ['round', ['get', 'elev_m']], 250], 0] as any}
            layout={{
              visibility: showContours ? 'visible' : 'none',
              'symbol-placement': 'line',
              'text-field': ['concat', ['to-string', ['round', ['get', 'elev_m']]], 'm'] as any,
              'text-font': ['Noto Sans Regular'],
              'text-size': 10,
            }}
            paint={{
              'text-color': 'rgba(120,85,40,0.9)',
              'text-halo-color': 'rgba(255,255,255,0.8)',
              'text-halo-width': 1,
            }}
          />
        </VectorSource>
        )}

        {/* ── Airspace ──────────────────────────────────── */}
        {/* Always-mounted — visibility toggled via layout.visibility, not mount/unmount.
            MapLibre Native throws 'id cannot be changed' when same id is removed then re-added. */}
        <GeoJSONSource id="ofm-airspace" onPress={() => {}} data={airspaceData}>
          {/* Static per-class fill colours: no data-driven colour expression on a
              GeoJSON fill layer. An expression-valued fill-color aborted the app on
              iOS at style load (uncaught exception in MLRNStyle setFillColor). */}
          {asVariants.filter(v => v.fill).map(v => (
            <Layer key={`as-fill-${v.k}`} id={`as-fill-${v.k}`} type="fill" filter={v.f as any} paint={{ 'fill-color': v.fill as string, 'fill-opacity': v.kind === 'ctr' ? ['interpolate', ['linear'], ['zoom'], 10, 1, 12, 0.15] as any : 1 }} layout={{ visibility: v.show ? 'visible' : 'none' }} />
          ))}
          <Layer id="as-fill-r" type="fill" filter={filterRed as any} paint={{ 'fill-color': AC.rFill, 'fill-opacity': 1 }} layout={{ visibility: showRestricted ? 'visible' : 'none' }} />
          <Layer id="as-fill-tra" type="fill" filter={['all', filterRestricted, ['==', ['get', 'class'], 'TRA']] as any} paint={{ 'fill-color': AC.traFill, 'fill-opacity': 1 }} layout={{ visibility: showRestricted ? 'visible' : 'none' }} />
          <Layer id="as-fill-gldr" type="fill" filter={['all', filterActivity, ['==', ['get', 'class'], 'GLDR']] as any} paint={{ 'fill-color': AC.gldrFill, 'fill-opacity': 1 }} layout={{ visibility: showActivity ? 'visible' : 'none' }} />
          <Layer id="as-fill-model" type="fill" filter={['all', filterActivity, ['==', ['get', 'class'], 'MODEL']] as any} paint={{ 'fill-color': AC.modelFill, 'fill-opacity': 1 }} layout={{ visibility: showActivity ? 'visible' : 'none' }} />
          {/* Inset shading bands — wide translucent line offset INTO the polygon
              interior via positive line-offset. Source geometry is Polygon, so
              MapLibre's polygon-aware line-offset inset/outset is winding-order
              independent (see AGENTS.md / docs/architecture.md for the style-spec
              citation). Shows unambiguously which side of the boundary the
              airspace occupies. */}
          {asVariants.map(v => (
            <Layer key={`as-inset-${v.k}`} id={`as-inset-${v.k}`} type="line" filter={['all', v.f, ['==', ['geometry-type'], 'Polygon']] as any} layout={{ visibility: v.show ? 'visible' : 'none' }} paint={{ 'line-color': v.col, 'line-width': v.p.inset.w, 'line-offset': v.p.inset.off, 'line-opacity': v.p.inset.op * (v.band ?? 1) }} />
          ))}

          {asVariants.map(v => (
            <Layer key={`as-bdr-${v.k}`} id={`as-bdr-${v.k}`} type="line" filter={['all', v.f, ['==', ['geometry-type'], 'Polygon']] as any} layout={{ visibility: v.show ? 'visible' : 'none' }} paint={{ 'line-color': v.col, 'line-width': v.p.bdr.w * (v.width ?? 1), ...(v.p.bdr.dash ? { 'line-dasharray': v.p.bdr.dash } : {}) }} />
          ))}

          {/* On-map class + altitude-range labels, placed along the boundary line
              (repeats around the perimeter, stays visible even off-centre).
              text-font is required — MapLibre Native silently drops the whole
              layer without it. */}
          {asVariants.map(v => (
            <Layer key={`as-label-${v.k}`} id={`as-label-${v.k}`} type="symbol" filter={['all', v.f, ['==', ['geometry-type'], 'Polygon']] as any} layout={{ visibility: v.show ? 'visible' : 'none', 'symbol-placement': 'line', 'text-offset': [0, 1], 'text-field': v.p.label.field as any, 'text-size': v.p.label.size, 'symbol-spacing': 200, 'text-font': ['Noto Sans Regular'] }} paint={{ 'text-color': v.col, 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 }} />
          ))}
        </GeoJSONSource>


        {/* ── Runways ──────────────────────────────────────── */}
        <GeoJSONSource id="ofm-runways" data={runwaysData}>
            <Layer
              id="runways-outline"
              type="line"
              layout={{ visibility: showRunways ? 'visible' : 'none', 'line-cap': 'butt' }}
              minzoom={11}
              paint={{
                'line-color': RUNWAY_COLORS.outline,
                'line-width': [
                  'interpolate', ['exponential', 2], ['zoom'],
                  11, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 1.5],
                  14, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 7],
                  17, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 32],
                ],
                'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 12, 0.9],
              }}
            />
            {RUNWAY_SURFACES.map(rs => (
              <Layer
                key={rs.k}
                id={`runways-line-${rs.k}`}
                filter={rs.f as any}
                type="line"
                layout={{ visibility: showRunways ? 'visible' : 'none', 'line-cap': 'butt' }}
                minzoom={11}
                paint={{
                  'line-color': rs.col,
                  'line-width': [
                    'interpolate', ['exponential', 2], ['zoom'],
                    11, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 1],
                    14, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 5],
                    17, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 24],
                  ],
                  'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 12, 1],
                }}
              />
            ))}
          </GeoJSONSource>

        {/* ── Aerodromes ───────────────────────────────────── */}
        <GeoJSONSource id="ofm-aerodromes" onPress={() => {}} data={aerodromesData}>
            {/* Towered-airport ATC status ring -- mirrors web map-style.ts
                aerodromes-atc-ring. Filtered to towered===true only; color
                driven by atcRingMatchExpr state (60s-interval recompute, see
                effect above). Declared before aerodromes-circle so the icon
                symbol paints on top / reads as a halo around it. */}
            {[
              { k: 'unknown', col: AERODROME_COLORS.atcUnknown, f: ['!', ['in', ['get', 'icao'], ['literal', [...atcOpenIcaos, ...atcClosedIcaos]]]] },
              { k: 'open',    col: AERODROME_COLORS.atcOpen,    f: ['in', ['get', 'icao'], ['literal', atcOpenIcaos]] },
              { k: 'closed',  col: AERODROME_COLORS.atcClosed,  f: ['in', ['get', 'icao'], ['literal', atcClosedIcaos]] },
            ].map(r => (
              <Layer
                key={r.k}
                id={r.k === 'unknown' ? 'aerodromes-atc-ring' : `aerodromes-atc-ring-${r.k}`}
                type="circle"
                filter={['all', ['==', ['get', 'towered'], true], r.f] as any}
                layout={{ visibility: showAerodromes ? 'visible' : 'none' }}
                paint={{
                  'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 5, 10, 7.5, 13, 10],
                  'circle-color': 'rgba(0,0,0,0)',
                  'circle-stroke-width': 2,
                  'circle-stroke-color': r.col,
                }}
              />
            ))}
            <Layer
              id="aerodromes-circle"
              layout={{
                visibility: showAerodromes ? 'visible' : 'none',
                'icon-image': ['match', ['get', 'type'], 'HP', 'ad-heliport', 'ad-airport'],
                'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 10, 0.45, 13, 0.6],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
              }}
              type="symbol"
              minzoom={6}
            />
            <Layer
              id="aerodromes-label"
              type="symbol"
              minzoom={8}
              layout={{
                visibility: showAerodromes ? 'visible' : 'none',
                'text-field': ['get', 'icao'],
                'text-size': 11,
                'text-offset': [0, 1.3],
                'text-font': ['Noto Sans Regular'],
              }}
              paint={{
                'text-color': theme.textPrimary,
                'text-halo-color': theme.surfaceBase,
                'text-halo-width': 1.5,
              }}
            />
            {/* NOTAM keyword hint badge (warning/clock emoji) -- mirrors
                web's map-style.ts 'aerodromes-notam-hint'. filter/text-field
                driven by notamHintFilter/notamHintTextExpr state (60s-
                interval bulk fetch, see effect above). Text-only signal,
                never affects aerodromes-atc-ring's color. */}
            <Layer
              id="aerodromes-notam-hint"
              type="symbol"
              minzoom={7}
              filter={notamHintFilter as any}
              layout={{
                'text-field': notamHintTextExpr as any,
                'text-font': ['Noto Sans Regular'],
                'text-size': 13,
                'text-anchor': 'bottom-left',
                'text-offset': [0.6, -0.6],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{
                'text-halo-color': '#ffffff',
                'text-halo-width': 1.5,
              }}
            />
          </GeoJSONSource>

        {/* ── Navaids ──────────────────────────────────────── */}
        <GeoJSONSource id="ofm-navaids" onPress={() => {}} data={navaidsData}>
            <Layer
              id="navaids-circle"
              layout={{
                visibility: showNavaids ? 'visible' : 'none',
                'icon-image': ['match', ['get', 'kind'], 'VOR', 'nav-vor', 'nav-ndb'],
                'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.22, 10, 0.35, 13, 0.5],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
              }}
              type="symbol"
              minzoom={6}
            />
            <Layer
              id="navaids-label"
              type="symbol"
              minzoom={7}
              layout={{
                visibility: showNavaids ? 'visible' : 'none',
                'text-field': ['get', 'id'],
                'text-size': 10,
                'text-offset': [0, 1.2],
                'text-font': ['Noto Sans Regular'],
              }}
              paint={{
                'text-color': theme.textSecondary,
                'text-halo-color': theme.surfaceBase,
                'text-halo-width': 1.5,
              }}
            />
          </GeoJSONSource>

        {/* ── Waypoints (MRP) ──────────────────────────────── */}
        <GeoJSONSource id="ofm-waypoints" onPress={() => {}} data={waypointsData}>
            <Layer
              id="waypoints-mrp-circle"
              layout={{
                visibility: showWaypoints ? 'visible' : 'none',
                'icon-image': 'wp-mrp',
                'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.22, 10, 0.35, 13, 0.5],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
              }}
              type="symbol"
              minzoom={8}
              filter={['==', ['get', 'wp_type'], 'MRP']}
            />
            <Layer
              id="waypoints-mrp-label"
              type="symbol"
              minzoom={9}
              filter={['==', ['get', 'wp_type'], 'MRP']}
              layout={{
                visibility: showWaypoints ? 'visible' : 'none',
                'text-field': ['get', 'id'],
                'text-size': 9,
                'text-offset': [0, 1.1],
                'text-font': ['Noto Sans Regular'],
              }}
              paint={{
                'text-color': WAYPOINT_COLORS.mrp,
                'text-halo-color': theme.surfaceBase,
                'text-halo-width': 1,
              }}
            />
            <Layer
              id="waypoints-rp-circle"
              layout={{
                visibility: showWaypoints ? 'visible' : 'none',
                'icon-image': 'wp-rp',
                'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.22, 10, 0.35, 13, 0.5],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
              }}
              type="symbol"
              minzoom={8}
              filter={['==', ['get', 'wp_type'], 'RP']}
            />
            <Layer
              id="waypoints-rp-label"
              type="symbol"
              minzoom={9}
              filter={['==', ['get', 'wp_type'], 'RP']}
              layout={{
                visibility: showWaypoints ? 'visible' : 'none',
                'text-field': ['get', 'id'],
                'text-size': 9,
                'text-offset': [0, 1.1],
                'text-font': ['Noto Sans Regular'],
              }}
              paint={{
                'text-color': WAYPOINT_COLORS.rp,
                'text-halo-color': theme.surfaceBase,
                'text-halo-width': 1,
              }}
            />
          </GeoJSONSource>

        {/* ── Obstacles ────────────────────────────────────── */}
        <GeoJSONSource id="openaip-obstacles" onPress={() => {}} data={obstaclesData}>
            <Layer
              id="obstacles-circle"
              layout={{
                visibility: showObstacles ? 'visible' : 'none',
                'icon-image': [
                  'match', ['get', 'kind'],
                  'wind_turbine', 'obs-wind-turbine',
                  'tower',        'obs-tower',
                  'chimney',      'obs-chimney',
                  'building',     'obs-building',
                                  'obs-other',
                ],
                'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.22, 11, 0.35, 14, 0.5],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
              }}
              type="symbol"
              minzoom={9}
            />
            <Layer
              id="obstacles-label"
              type="symbol"
              minzoom={12}
              layout={{
                visibility: showObstacles ? 'visible' : 'none',
                'text-field': ['concat', ['to-string', ['get', 'elevation_ft']], '\''],
                'text-size': 9,
                'text-offset': [0, 1.1],
                'text-font': ['Noto Sans Regular'],
              }}
              paint={{
                'text-color': theme.textMuted,
                'text-halo-color': theme.surfaceBase,
                'text-halo-width': 1,
              }}
            />
          </GeoJSONSource>
        {/* ── OSM Landmarks ─────────────────────────────────── */}
        <GeoJSONSource id="osm-landmarks" data={landmarksData}>
          <Layer
            id="landmarks-circle"
            type="symbol"
            minzoom={10}
            layout={{
              visibility: showLandmarks ? 'visible' : 'none',
              'icon-image': [
                'match', ['get', 'kind'],
                'church',      'lmk-church',
                'mast',        'lmk-mast',
                'windmill',    'lmk-windmill',
                'water_tower', 'lmk-water-tower',
                'chimney',     'lmk-chimney',
                               'lmk-church',
              ],
              'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.3, 14, 0.5],
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
            }}
          />
          {LANDMARK_LABEL_COLORS.map(lk => (
            <Layer
              key={lk.k}
              id={`landmarks-label-${lk.k}`}
              type="symbol"
              minzoom={13}
              filter={['all', ['!=', ['get', 'name'], ''], lk.f] as any}
              layout={{
                visibility: showLandmarks ? 'visible' : 'none',
                'text-field': ['get', 'name'],
                'text-font': ['Noto Sans Regular'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 16, 11],
                'text-anchor': 'top',
                'text-offset': [0, 0.6],
                'text-optional': true,
              }}
              paint={{
                'text-color': lk.col,
                'text-halo-color': 'rgba(255,255,255,0.9)',
                'text-halo-width': 1.5,
              }}
            />
          ))}
        </GeoJSONSource>

        {/* ── Runway threshold designators ─────────────────── */}
        <GeoJSONSource id="ofm-runway-thresholds" data={runwayThresholdsData}>
          <Layer
            id="runway-threshold-label"
            type="symbol"
            minzoom={12}
            layout={{
              visibility: showRunways ? 'visible' : 'none',
              'text-field': ['get', 'id'],
              'text-font': ['Noto Sans Medium'],
              // Bumped for the wind-favored end (bigger draws the eye) --
              // same expression/logic web's map-style.ts applies via
              // setPaintProperty, shared via buildRunwayWindHighlight so
              // "favored" means exactly the same thing on both platforms.
              'text-size': runwayWindExpr.size as any,
              // mag_brg is a "not yet computed" placeholder `0` for a large
              // fraction of thresholds in the source data (true_brg is
              // always populated) -- coalesce alone doesn't catch that (only
              // null/undefined substitute), so this falls back to true_brg
              // whenever mag_brg is exactly 0. Same fix as web's
              // map-style.ts 'runway-threshold-label' layer, and matches
              // @open-vfr/shared/runwayWind's effectiveMagBrg used by every
              // JS-side reader of this same field.
              'text-rotate': [
                'case',
                ['==', ['coalesce', ['get', 'mag_brg'], 0], 0],
                ['coalesce', ['get', 'true_brg'], 0],
                ['get', 'mag_brg'],
              ] as any,
              'text-rotation-alignment': 'map',
              'text-allow-overlap': true,
              'text-ignore-placement': true,
            }}
            paint={{
              'text-color': runwayWindExpr.color as any,
              'text-halo-color': runwayWindExpr.haloColor as any,
              'text-halo-width': 1.5,
              'text-opacity': runwayWindExpr.opacity as any,
            }}
          />
        </GeoJSONSource>

        {profileCursorStore && <ProfileCursorLayer store={profileCursorStore} />}

                {/* ── Past flight log track (Logs segment "View") ──── */}
        {pastTrack && pastTrack.length > 1 && (
          <GeoJSONSource id="past-track-src" data={{ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pastTrack } }] }}>
            <Layer
              id="past-track-line"
              type="line"
              paint={{ 'line-color': '#a78bfa', 'line-width': 3, 'line-opacity': 0.85 }}
            />
          </GeoJSONSource>
        )}

                {/* ── Trajectory line + tick marks ──────────────── */}
        {trajectoryFC.features.length > 0 && (
          <GeoJSONSource id="trajectory-src" data={trajectoryFC}>
            <Layer
              id="trajectory-line"
              type="line"
              filter={['==', ['get', 'type'], 'line']}
              paint={{ 'line-color': '#facc15', 'line-width': 3, 'line-opacity': 0.9 }}
            />
            <Layer
              id="trajectory-ticks"
              type="line"
              filter={['==', ['get', 'type'], 'tick']}
              paint={{ 'line-color': '#facc15', 'line-width': 3, 'line-opacity': 0.9 }}
            />
          </GeoJSONSource>
        )}

        {/* Map Ruler — mirrors web's MapView.tsx ruler line + endpoint dots */}
        {rulerPoints && rulerPoints.length >= 1 && (
          <GeoJSONSource
            id="ruler-pts-src"
            data={{
              type: 'FeatureCollection',
              features: rulerPoints.map((p, i) => ({
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
                properties: { label: i === 0 ? 'A' : 'B' },
              })),
            }}
          >
            <Layer
              id="ruler-pts-circle"
              type="circle"
              paint={{
                'circle-radius': 6,
                'circle-color': '#facc15',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#000000',
              }}
            />
          </GeoJSONSource>
        )}
        {rulerPoints && rulerPoints.length === 2 && (
          <GeoJSONSource
            id="ruler-line-src"
            data={{
              type: 'FeatureCollection',
              features: [{
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: rulerPoints.map((p) => [p.lng, p.lat]) },
                properties: {},
              }],
            }}
          >
            <Layer
              id="ruler-line"
              type="line"
              paint={{ 'line-color': '#facc15', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 }}
            />
          </GeoJSONSource>
        )}

        {/* -- Traffic (ADS-B / OpenSky + FLARM / OGN) --------------------- */}
        {/* Two-layer design mirrors web's map-style.ts 'traffic-urgency-ring' +
            'traffic-symbols': a coloured proximity backdrop behind a
            category-specific aircraft silhouette (iconId pre-computed in
            useTraffic.ts via selectTrafficIcon()), replacing the earlier
            plain-circle-only rendering -- gliders, helicopters, balloons,
            parachutists, UAVs, and airliners now render distinctly instead
            of all being the same dot. */}
        {trafficFC && trafficFC.features.length > 0 && (
          <GeoJSONSource id="traffic-src" data={trafficFC}>
            {([[1, '#22c55e'], [2, '#eab308'], [3, '#ef4444']] as const).map(([u, c]) => (
              <Layer
                key={u}
                id={`traffic-urgency-ring-${u}`}
                type="circle"
                filter={['==', ['get', 'urgency'], u] as any}
                paint={{
                  'circle-radius': 11,
                  'circle-color': c,
                  'circle-opacity': 0.35,
                  'circle-stroke-color': c,
                  'circle-stroke-width': 1.5,
                  'circle-stroke-opacity': 0.8,
                }}
              />
            ))}
            <Layer
              id="traffic-symbols"
              type="symbol"
              layout={{
                'icon-image': ['coalesce', ['get', 'iconId'], 'traffic-icon-a0'],
                'icon-size': 0.5,
                'icon-rotate': ['get', 'trackDeg'],
                'icon-rotation-alignment': 'map',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'text-field': ['coalesce', ['get', 'callsign'], ['get', 'icao24']],
                'text-font': ['Noto Sans Regular'],
                'text-size': 9,
                'text-anchor': 'top',
                'text-offset': [0, 0.8],
                'text-allow-overlap': false,
              }}
              paint={{
                'icon-opacity': 0.9,
                'text-color': '#ffffff',
                'text-halo-color': 'rgba(0,0,0,0.7)',
                'text-halo-width': 1,
              }}
            />
          </GeoJSONSource>
        )}

        {/* ── Planned Route ──────────────────────────────── */}
        {waypoints.length >= 2 && routeVisible && (
          <>
          {/* Original route, left untouched (faded) while a point is dragged. */}
          {ghostLegs && (
            <GeoJSONSource id="route-ghost-src" data={ghostLegs}>
              <Layer
                id="route-ghost-line" type="line"
                paint={{ 'line-color': theme.accentMagenta, 'line-width': 2.5, 'line-dasharray': [6, 3], 'line-opacity': 0.3 }}
              />
            </GeoJSONSource>
          )}
          <GeoJSONSource id="route-legs-src" data={routeLegs} onPress={onLegTap ? () => {} : undefined}>
            <Layer
              id="route-legs-line" type="line"
              paint={{ 'line-color': routeDragActive ? DRAG_ROUTE_COLOR : theme.accentMagenta, 'line-width': 2.5, 'line-dasharray': [6, 3] }}
            />
            {onLegTap && (
              <Layer
                id="route-legs-hit" type="line"
                paint={{ 'line-color': '#000000', 'line-opacity': 0.01, 'line-width': 22 }}
              />
            )}
          </GeoJSONSource>
          </>
        )}

        {/* Ring at the exact position the point will land, above the finger. */}
        {dropPointFC && (
          <GeoJSONSource id="route-drop-src" data={dropPointFC}>
            <Layer
              id="route-drop-ring" type="circle"
              paint={{ 'circle-radius': 12, 'circle-color': 'rgba(255,152,0,0.18)', 'circle-stroke-width': 2, 'circle-stroke-color': DRAG_ROUTE_COLOR }}
            />
          </GeoJSONSource>
        )}

        {waypoints.length >= 1 && routeVisible && (
          <GeoJSONSource id="route-pts-src" data={routePoints} onPress={onWaypointMove ? () => {} : undefined}>
            <Layer
              id="route-pts-circle" type="circle"
              paint={{ 'circle-radius': 7, 'circle-color': theme.accentMagenta, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' }}
            />
            <Layer
              id="route-pts-label" type="symbol"
              layout={{ 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, -1.4], 'text-font': ['Noto Sans Medium'] }}
              paint={{ 'text-color': theme.accentMagenta, 'text-halo-color': theme.surfaceBase, 'text-halo-width': 1.5 }}
            />
          </GeoJSONSource>
        )}

        {/* ── Saved user waypoints (independent of planned route) ───── */}
        {userWaypointsFC && userWaypointsFC.features.length > 0 && (
          <GeoJSONSource id="user-waypoints-src" data={userWaypointsFC}>
            <Layer
              id="user-waypoints-circle" type="circle"
              paint={{
                'circle-radius': 6,
                'circle-color': theme.accentYellow,
                'circle-stroke-width': 2,
                'circle-stroke-color': '#fff',
              }}
            />
            <Layer
              id="user-waypoints-label" type="symbol"
              layout={{
                'text-field': ['get', 'name'],
                'text-size': 11,
                'text-offset': [0, 1.2],
                'text-font': ['Noto Sans Medium'],
              }}
              paint={{
                'text-color': theme.accentYellow,
                'text-halo-color': theme.surfaceBase,
                'text-halo-width': 1.5,
              }}
            />
          </GeoJSONSource>
        )}

        {notamCirclesFC && notamCirclesFC.features.length > 0 && (
          <GeoJSONSource id="notam-circles-src" data={notamCirclesFC} onPress={() => {}}>
            <Layer
              id="notam-circles-fill" type="fill"
              paint={{ 'fill-color': '#e64980', 'fill-opacity': 0.12 }}
            />
            <Layer
              id="notam-circles-border" type="line"
              paint={{ 'line-color': '#e64980', 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.8 }}
            />
          </GeoJSONSource>
        )}

        {notamPolygonsFC && notamPolygonsFC.features.length > 0 && (
          <GeoJSONSource id="notam-polygons-src" data={notamPolygonsFC} onPress={() => {}}>
            <Layer
              id="notam-polygons-fill" type="fill"
              paint={{ 'fill-color': '#e64980', 'fill-opacity': 0.12 }}
            />
            <Layer
              id="notam-polygons-border" type="line"
              paint={{ 'line-color': '#e64980', 'line-width': 1.5, 'line-opacity': 0.85 }}
            />
          </GeoJSONSource>
        )}

        {notamPointsFC && notamPointsFC.features.length > 0 && (
          <GeoJSONSource
            id="notam-points-src"
            ref={notamPointsSourceRef}
            data={notamPointsFC}
            cluster
            clusterMaxZoom={14}
            clusterRadius={50}
            onPress={() => {}}
          >
            <Layer
              id="notam-points-cluster" type="circle"
              filter={['has', 'point_count'] as any}
              paint={{
                'circle-color': '#e64980',
                'circle-opacity': 0.85,
                'circle-radius': ['step', ['get', 'point_count'], 12, 10, 16, 25, 20] as any,
                'circle-stroke-width': 1.5,
                'circle-stroke-color': '#ffffff',
              }}
            />
            <Layer
              id="notam-points-cluster-count" type="symbol"
              filter={['has', 'point_count'] as any}
              layout={{
                'text-field': ['get', 'point_count_abbreviated'] as any,
                'text-size': 11,
                'text-font': ['Noto Sans Medium'],
              }}
              paint={{ 'text-color': '#ffffff' }}
            />
            <Layer
              id="notam-points-unclustered" type="circle"
              filter={['!', ['has', 'point_count']] as any}
              paint={{
                'circle-color': '#e64980',
                'circle-opacity': 0.9,
                'circle-radius': 7,
                'circle-stroke-width': 1.5,
                'circle-stroke-color': '#ffffff',
              }}
            />
          </GeoJSONSource>
        )}

        {/* ── Ambient wind-arrows overlay ──────────────────────────
            Mirrors web's map-style.ts 'wind-grid' source + 'wind-arrows-
            icon' layer exactly: same bucketed icon-id
            expression (@open-vfr/shared/windBarb), dirDeg rotation (wind-
            FROM convention, no +180 -- see web's comment), bottom anchor.
            Native can't canvas-draw icons at runtime like web's
            registerWindBarbIcon, so all 21 buckets are pre-rendered PNGs
            (apps/native/assets/poi_icons/wind-barb-{0,5,...,100}.png,
            generated by the same barb-drawing algorithm) registered via
            <Images> below, matching web's icon set 1:1. */}
        <GeoJSONSource id="wind-grid" data={windGridFC ?? { type: 'FeatureCollection', features: [] }}>
          <Layer
            id="wind-arrows-icon"
            type="symbol"
            layout={{
              visibility: showWind ? 'visible' : 'none',
              'icon-image': [
                'concat', 'wind-barb-',
                ['to-string', ['max', 0, ['min', 100,
                  ['*', ['round', ['/', ['get', 'speedKts'], 5]], 5],
                ]]],
              ] as any,
              'icon-rotate': ['get', 'dirDeg'] as any,
              'icon-rotation-alignment': 'map',
              'icon-anchor': 'bottom',
              // 2026-09-13 UX pass shrunk this (0.4-0.8/opacity 0.55) to stop
              // barbs dominating the map -- overcorrected into near-invisible.
              // Restored to match web's map-style.ts; the icons themselves are
              // now speed-tiered blue/green/amber (baked into the PNGs by
              // gen-wind-barb-icons.mjs) so strength -- not just size/opacity
              // -- carries the "don't overwhelm the map" signal.
              'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.55, 10, 0.85, 14, 1.1] as any,
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
            }}
            paint={{ 'icon-opacity': 0.9 }}
          />
          {/* Deliberately no permanent "Nkt" text layer alongside the barb
              icon (there used to be one, 'wind-arrows-label') -- see web's
              identical comment in map-style.ts for why: the barb shape
              itself already carries the at-a-glance strength read, and a
              permanent small text label was flagged as hard to read in a
              pre-release pass. */}
        </GeoJSONSource>

        {/* ── Aircraft position ──────────────────────────── */}
        <Images images={{
          'aircraft-icon':    require('../../assets/aircraft_icons/cessna.png'),
          'wind-barb-0':      require('../../assets/poi_icons/wind-barb-0.png'),
          'wind-barb-5':      require('../../assets/poi_icons/wind-barb-5.png'),
          'wind-barb-10':     require('../../assets/poi_icons/wind-barb-10.png'),
          'wind-barb-15':     require('../../assets/poi_icons/wind-barb-15.png'),
          'wind-barb-20':     require('../../assets/poi_icons/wind-barb-20.png'),
          'wind-barb-25':     require('../../assets/poi_icons/wind-barb-25.png'),
          'wind-barb-30':     require('../../assets/poi_icons/wind-barb-30.png'),
          'wind-barb-35':     require('../../assets/poi_icons/wind-barb-35.png'),
          'wind-barb-40':     require('../../assets/poi_icons/wind-barb-40.png'),
          'wind-barb-45':     require('../../assets/poi_icons/wind-barb-45.png'),
          'wind-barb-50':     require('../../assets/poi_icons/wind-barb-50.png'),
          'wind-barb-55':     require('../../assets/poi_icons/wind-barb-55.png'),
          'wind-barb-60':     require('../../assets/poi_icons/wind-barb-60.png'),
          'wind-barb-65':     require('../../assets/poi_icons/wind-barb-65.png'),
          'wind-barb-70':     require('../../assets/poi_icons/wind-barb-70.png'),
          'wind-barb-75':     require('../../assets/poi_icons/wind-barb-75.png'),
          'wind-barb-80':     require('../../assets/poi_icons/wind-barb-80.png'),
          'wind-barb-85':     require('../../assets/poi_icons/wind-barb-85.png'),
          'wind-barb-90':     require('../../assets/poi_icons/wind-barb-90.png'),
          'wind-barb-95':     require('../../assets/poi_icons/wind-barb-95.png'),
          'wind-barb-100':    require('../../assets/poi_icons/wind-barb-100.png'),
          'obs-wind-turbine': require('../../assets/poi_icons/obs-wind-turbine.png'),
          'obs-tower':        require('../../assets/poi_icons/obs-tower.png'),
          'obs-chimney':      require('../../assets/poi_icons/obs-chimney.png'),
          'obs-building':     require('../../assets/poi_icons/obs-building.png'),
          'obs-other':        require('../../assets/poi_icons/obs-other.png'),
          'lmk-church':       require('../../assets/poi_icons/lmk-church.png'),
          'lmk-mast':         require('../../assets/poi_icons/lmk-mast.png'),
          'lmk-windmill':     require('../../assets/poi_icons/lmk-windmill.png'),
          'lmk-water-tower':  require('../../assets/poi_icons/lmk-water-tower.png'),
          'lmk-chimney':      require('../../assets/poi_icons/lmk-chimney.png'),
          'nav-vor':          require('../../assets/poi_icons/nav-vor.png'),
          'nav-ndb':          require('../../assets/poi_icons/nav-ndb.png'),
          'wp-mrp':           require('../../assets/poi_icons/wp-mrp.png'),
          'wp-rp':            require('../../assets/poi_icons/wp-rp.png'),
          'ad-airport':       require('../../assets/poi_icons/ad-airport.png'),
          'ad-heliport':      require('../../assets/poi_icons/ad-heliport.png'),
          // Traffic silhouettes -- id-for-id parity with web's TRAFFIC_ICON_ENTRIES
          // (apps/web/src/utils/trafficIcons.ts), pre-rasterized by
          // scripts/gen-aircraft-icons.mjs since native can't recolor SVGs
          // at runtime. Selection logic (category+speed -> id) lives in
          // src/utils/trafficIcons.ts, applied in useTraffic.ts.
          'traffic-icon-a0':      require('../../assets/aircraft_icons/traffic-icon-a0.png'),
          'traffic-icon-a7':      require('../../assets/aircraft_icons/traffic-icon-a7.png'),
          'traffic-icon-b1':      require('../../assets/aircraft_icons/traffic-icon-b1.png'),
          'traffic-icon-b2':      require('../../assets/aircraft_icons/traffic-icon-b2.png'),
          'traffic-icon-b3':      require('../../assets/aircraft_icons/traffic-icon-b3.png'),
          'traffic-icon-b4':      require('../../assets/aircraft_icons/traffic-icon-b4.png'),
          'traffic-icon-c0':      require('../../assets/aircraft_icons/traffic-icon-c0.png'),
          'traffic-icon-cessna':  require('../../assets/aircraft_icons/traffic-icon-cessna.png'),
          'traffic-icon-learjet': require('../../assets/aircraft_icons/traffic-icon-learjet.png'),
          'traffic-icon-dh8a':    require('../../assets/aircraft_icons/traffic-icon-dh8a.png'),
          'traffic-icon-crjx':    require('../../assets/aircraft_icons/traffic-icon-crjx.png'),
          'traffic-icon-a320':    require('../../assets/aircraft_icons/traffic-icon-a320.png'),
          'traffic-icon-b737':    require('../../assets/aircraft_icons/traffic-icon-b737.png'),
          'traffic-icon-b747':    require('../../assets/aircraft_icons/traffic-icon-b747.png'),
          'traffic-icon-a380':    require('../../assets/aircraft_icons/traffic-icon-a380.png'),
          'traffic-icon-f15':     require('../../assets/aircraft_icons/traffic-icon-f15.png'),
        }} />

        {aircraftFC && (
          <GeoJSONSource id="aircraft-src" data={aircraftFC}>
            <Layer
              id="aircraft-symbol"
              type="symbol"
              layout={{
                'icon-image':              'aircraft-icon',
                'icon-rotate':             ['get', 'trackDeg'],
                'icon-rotation-alignment': 'map',
                'icon-allow-overlap':      true,
                'icon-ignore-placement':   true,
                'icon-size':               0.5,
              }}
            />
          </GeoJSONSource>
        )}

        {/* Per-waypoint native drag targets — must be children of <Map>
            (ViewAnnotation is positioned/managed by the native map SDK
            itself, not by RN's view/touch layout system) so drag touches
            are owned natively and never race the map's own pan/pinch/long-
            press recognizers. A prior PanResponder-sibling-overlay approach
            never received touches at all: MapLibreGLSurfaceView intercepts
            all touch input before it reaches JS gesture responders on
            sibling views (see AGENTS.md "MapLibre RN — touch interception").
            Long-press-for-popup and normal map pan continue to work
            everywhere except exactly on a waypoint's small drag handle. */}
        {onWaypointMove && !editLocked && waypoints.map((wp, i) => (
          <WaypointDragAnnotation
            key={i}
            wpIndex={i}
            lat={dragPreview?.wpIndex === i ? (dragPreview.fingerLat ?? dragPreview.lat) : wp.lat}
            lng={dragPreview?.wpIndex === i ? (dragPreview.fingerLng ?? dragPreview.lng) : wp.lng}
            onGrab={() => startDrag(i, wp.lat, wp.lng)}
            onMove={moveDrag}
            onRelease={releaseDrag}
          />
        ))}

        {/* Leg-midpoint drag-insert handles — non-filled circle at the
            midpoint of every leg. Mirrors web's route-midpoints-layer.
            Rendered unconditionally per-leg (like WaypointDragAnnotation
            above) — the native SDK owns the visual position while a drag is
            in progress regardless of the lngLat prop we pass on re-render,
            so there's no need to hide/swap the active one. */}
        {onLegInsert && !editLocked && routeVisible && waypoints.length >= 2 && legMidpointWps.slice(0, -1).map((from, i) => {
          const to = legMidpointWps[i + 1]
          return (
            <LegMidpointAnnotation
              key={i}
              legIndex={i}
              lat={(from.lat + to.lat) / 2}
              lng={(from.lng + to.lng) / 2}
              onGrab={startLegDrag}
              onMove={moveLegDrag}
              onRelease={releaseLegDrag}
            />
          )
        })}
      </Map>

      {/* Status pill (bottom-right): (i) attribution button, airspace altitude
          filter, scale bar and 1:N ratio -- same content as web's MapInfoBar.
          The (i) replaces MapLibre Native's own button/dialog, which drops all
          but one source's credit on Android. */}
      <MapInfoBar
        ref={infoBarRef}
        ceilingFt={airspaceCeilingFt}
        distanceUnit={distanceUnit}
        initialCamera={{ lat: camStateRef.current.lat, zoom: camStateRef.current.zoom }}
        onInfoPress={() => setShowAttribution(true)}
      />
      <NativeSheet
        isPresented={showAttribution}
        onDismiss={() => setShowAttribution(false)}
        title="Map data & attribution"
        testID="attribution-sheet"
      >
        {ATTRIBUTION_SOURCES.map((s) => (
          <TouchableOpacity
            key={s.name}
            style={attributionStyles.row}
            onPress={() => Linking.openURL(s.url)}
          >
            <Text style={attributionStyles.rowName}>{s.name}</Text>
            <Text style={attributionStyles.rowNote}>{s.note}</Text>
          </TouchableOpacity>
        ))}
      </NativeSheet>

      {/* Drag indicator overlay */}
      {dragging && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View style={dragStyles.hint}>
            <View style={dragStyles.dot} />
            <View style={dragStyles.label}><View style={dragStyles.labelBg}><View style={dragStyles.labelText} /></View></View>
          </View>
        </View>
      )}
    </View>
  )
}

function makeDragStyles(theme: ScaledTheme) {
 return {
  hint: {
    position:       'absolute',
    bottom:         80,
    alignSelf:      'center',
    alignItems:     'center',
    gap:            6,
  },
  dot: {
    width:           16,
    height:          16,
    borderRadius:    8,
    backgroundColor: '#f472b6',
    borderWidth:     2,
    borderColor:     '#fff',
  },
  label: {},
  labelBg: {
    backgroundColor: 'rgba(10,14,22,0.80)',
    borderRadius:    6,
    paddingHorizontal: 8,
    paddingVertical:   3,
  },
  labelText: {
    // placeholder — actual text omitted since we can't use dynamic hooks here
  },
} as const
}
