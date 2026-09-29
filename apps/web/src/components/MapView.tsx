import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, ExpressionSpecification } from 'maplibre-gl'
// MapLibre v6 is ESM-only and locates its worker via a computed
// `new URL('./maplibre-gl-worker.mjs', import.meta.url)` inside its own
// source — Rollup/Vite can't statically analyze that, so the worker chunk
// never gets emitted to dist/assets/. The browser then requests a
// nonexistent /assets/maplibre-gl-worker.mjs at runtime, which a typical
// SPA-fallback static host serves as index.html instead of a 404 —
// producing a "non-JavaScript MIME type" module-script error. Explicitly
// importing the worker with `?worker&url` routes it through Vite's worker
// plugin so the file (plus its shared-chunk deps) is actually emitted, and
// wiring maplibregl.setWorkerUrl() points MapLibre at the real emitted path.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
maplibregl.setWorkerUrl(maplibreWorkerUrl)
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  getMapStyle,
  getLanduseSource,
  getHillshadeSource,
  getContoursSource,
  DEFAULT_REGION,
  LAYER_GROUPS,
  AIRSPACE_BASE_FILTERS,
  buildAltitudeFilter,
  PROTOMAPS_LAYER_IDS,
  AVIATION_LABEL_LAYERS,
  AIRSPACE_BORDER_WIDTHS,
} from '../styles/map-style'
import { buildRunwayWindHighlight, effectiveMagBrg, type RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import { computeAtcStatus, isNotamAtcRelated, isNotamHoursChangeRelated, type HoursEntry as AtcHoursEntry } from '@open-vfr/shared/atcStatus'
import { sunriseSunset } from '@open-vfr/shared/sunCalc'
import { AERODROME_COLORS } from '@open-vfr/shared/featureColors'
import { fetchAerodromeNotamTexts, type NotamItem } from '@open-vfr/shared/fetchNotam'
import { API_BASE_URL } from '../utils/env'
import { type AerodromeFeatureProps } from './AerodromePopup'
import { registerObstacleImages } from '../utils/obstacleIcons'
import { registerLandmarkImages } from '../utils/landmarkIcons'
import { registerAerodromeImages } from '../utils/aerodromeIcons'
import { registerNavaidImages } from '../utils/navaidIcons'
import { registerWindBarbIcon, registerAllWindBarbIcons } from '../utils/windBarbIcons'
import { useWindGrid } from '../hooks/useWindGrid'
import { type AirspaceFeature, type RegionalNotamHit, airspaceRowKey, notamRowKey } from './AirspacePopup'
import { queryAirspaceAtPoint } from '@open-vfr/shared/airspaceQuery'
import { formatObstacleName, formatLandmarkName, obstacleWaypointName } from '@open-vfr/shared/snapLabels'
import { type PointFeature } from './FeaturePopup'
import type { WhatsHereItem } from './WhatsHerePopup'
import SnapPicker, { type SnapCandidate } from './SnapPicker'
import RouteEditBanner from './RouteEditBanner'
import VirtualRadar from './VirtualRadar'
import RulerSummaryStrip from './RulerSummaryStrip'
import { useWeatherAlongRoute } from '../hooks/useWeatherAlongRoute'
import { useWindAlongRoute } from '../hooks/useWindAlongRoute'
import { useVicinityAerodromes } from '../hooks/useVicinityAerodromes'
import { useNearbyFrequencies } from '../hooks/useNearbyFrequencies'
import VicinityBriefPanel from './VicinityBriefPanel'
import { useGpsVerticalSpeed } from '../hooks/useGpsVerticalSpeed'
import LiveTrackChart from './LiveTrackChart'
import LivePlogPanel from './LivePlogPanel'
import WpActionMenu from './WpActionMenu'
import LegActionMenu from './LegActionMenu'
import SideDrawer from './SideDrawer'
import ProfilePanel from './ProfilePanel'
import type { RouteWaypoint } from '../utils/routeCalc'
import { magneticBearingDeg, bearingDeg, advancePosition } from '../utils/routeCalc'
import { usePersistedRoute } from '../db/useRouteDb'
import { useHomeAirfield, useUnits, useAlternate, useTheme, useAutoZoom, useTrajectoryMode, useAirspaceWarnLookahead, useAirspaceWarnVerticalFt, useTerrainColoring, useTrafficVertFilter, useLayerVisibility, useAirspaceCeiling, useSelectedAircraftId, useParkTimeout } from '../db/useSettings'
import { useAircraftProfiles } from '../db/useAircraftProfiles'
import { useUserWaypoints } from '../db/useUserWaypoints'
import { getDb, type TrackPoint, type LegOverride } from '../db'
import { distanceNm } from '../utils/routeCalc'
import { distanceAlongRouteNm, coordinateAlongRouteNm, routeCrossTrackNm } from '@open-vfr/shared/virtualRadarCalc'
import { fetchWind, type WindAloft } from '@open-vfr/shared/fetchWind'
import { aircraftIconUrl, registerAircraftImageFromSvg } from '../utils/aircraftIcon'
import { buildTerrainColorExpr } from '../utils/terrainColor'
import { useLivePlog } from '../hooks/useLivePlog'
import { useGoFlying } from '../hooks/useGoFlying'
import { useNearestFeature, type TrackedPoint } from '../hooks/useNearestFeature'
import { useAirspaceWarnings } from '../hooks/useAirspaceWarnings'
import { useAirspaceNotifications } from '../hooks/useAirspaceNotifications'
import { useObstructionWarnings } from '../hooks/useObstructionWarnings'
import { useAirfieldProximity } from '../hooks/useAirfieldProximity'
import { useFlightLog } from '../hooks/useFlightLog'
import { useTraffic } from '../hooks/useTraffic'
import { useRegionalNotams } from '../hooks/useRegionalNotams'
import { usePassivePosition, readLastPosition, geolocationAlreadyGranted } from '../hooks/usePassivePosition'
import { useNotamVfrOnly } from '../hooks/useNotamPrefs'
import { isIfrOnly } from '@open-vfr/shared/notamRelevance'
import { useNotamWarnings } from '../hooks/useNotamWarnings'
import { useNotamNotifications } from '../hooks/useNotamNotifications'
import { useNotamAirspaceMatch } from '../hooks/useNotamAirspaceMatch'
import { makeCirclePolygon } from '@open-vfr/shared/geoCircle'
import { registerTrafficIcons, selectTrafficIcon } from '../utils/trafficIcons'
import GoFlyingPanel from './GoFlyingPanel'
import { NotificationCenter } from './NotificationCenter'
import AirfieldBriefPanel from './AirfieldBriefPanel'
import DirectToPanel from './DirectToPanel'
import FindDestPanel from './FindDestPanel'
import { useAirfieldBrief } from '../hooks/useAirfieldBrief'
import { useAerodromeWxHighlight } from '../hooks/useAerodromeWxHighlight'
import { useDataManifest } from '../hooks/useDataManifest'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import type { AuthState } from '../hooks/useAuth'
import type { FlyingMode, MapOrientation, GpsPosition } from '../utils/gpsTypes'
import { TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl, waitForTileManifest } from '@open-vfr/shared/tileManifest'
import { parseMapLink, hasMapLink, stripMapLinkParams } from '@open-vfr/shared/deepLink'
import css from './MapView.module.css'
import MapInfoBar from './MapInfoBar'

// MapLibre layer IDs we listen to for aerodrome clicks.
// All layers that reference the ofm-aerodromes source.
const AERODROME_LAYERS = ['aerodromes-icon', 'aerodromes-label']

// ── Glide range circle helper ─────────────────────────────────────────────
// Returns a GeoJSON Polygon approximating a circle of `radiusNm` NM centered
// at `lat/lng`.  Used for the glide-range ring layer.
// makeCirclePolygon now lives in @open-vfr/shared/geoCircle -- promoted
// there once native needed the identical math for its own NOTAM circle
// layer, rather than duplicating it a second time.

// Extracts the outer ring [[lng,lat]…] from a queried NOTAM feature's own
// geometry, for the AirspacePopup shape thumbnail — works for both the
// synthesized circle Polygon and a real-geometry Polygon/MultiPolygon;
// Point geometry (individual marker, no area) returns undefined so
// PolygonThumb falls back to its plain-square placeholder.
function notamGeometryRing(geom: GeoJSON.Geometry): number[][] | undefined {
  if (geom.type === 'Polygon') return geom.coordinates[0]
  if (geom.type === 'MultiPolygon') return geom.coordinates[0]?.[0]
  return undefined
}

// Same ring extraction as notamGeometryRing above, but from a NotamItem's
// OWN stored geometry (real polygon, or synthesized from lat/lon/radiusNm)
// rather than a queried map feature -- used by the sidebar's "MAP" jump-to
// action, which has no click event / queried feature to read from.
function notamItemRing(n: NotamItem): number[][] | undefined {
  if (n.polygon) {
    return n.polygon.type === 'Polygon' ? n.polygon.coordinates[0] : n.polygon.coordinates[0]?.[0]
  }
  if (n.lat !== null && n.lon !== null && n.radiusNm !== null && n.radiusNm > 0) {
    return makeCirclePolygon(n.lat, n.lon, n.radiusNm).geometry.coordinates[0]
  }
  return undefined
}

function ringBounds(ring: number[][]): [[number, number], [number, number]] {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat
  }
  return [[minLng, minLat], [maxLng, maxLat]]
}

// ── Extended centreline helper ────────────────────────────────────────────
// A runway threshold has a `mag_brg` (bearing FROM threshold toward the runway).
// The extended centreline is projected AWAY from the runway — i.e. the inbound
// approach direction is the RECIPROCAL of mag_brg. mag_brg is a "not yet
// computed" placeholder `0` for a large fraction of thresholds in the
// underlying dataset -- true_brg is carried alongside it and always
// populated, so every read goes through effectiveMagBrg (see runwayWind.ts)
// rather than trusting mag_brg directly.
interface ThresholdEntry { icao: string; lat: number; lng: number; mag_brg: number; true_brg: number | null }

function buildCentrelines(
  thresholds: ThresholdEntry[],
  aircraftLat: number,
  aircraftLng: number,
  aircraftHeading: number,
  nearDistNm: number,     // only show for airports within this radius
  lineNm: number,         // how far the extended centreline extends
): GeoJSON.FeatureCollection {
  // Find nearby airports (any threshold within nearDistNm)
  const nearbyIcaos = new Set<string>()
  for (const t of thresholds) {
    const dlat = (t.lat - aircraftLat) * 60           // approx NM
    const dlng = (t.lng - aircraftLng) * 60 * Math.cos(t.lat * Math.PI / 180)
    if (Math.sqrt(dlat * dlat + dlng * dlng) <= nearDistNm) nearbyIcaos.add(t.icao)
  }
  if (nearbyIcaos.size === 0) return { type: 'FeatureCollection', features: [] }

  // Inbound bearing = reciprocal of the effective (mag_brg-or-true_brg-
  // fallback) bearing.
  const inboundBrg = (t: ThresholdEntry) => ((effectiveMagBrg(t.mag_brg, t.true_brg) ?? 0) + 180) % 360
  // Angular difference between two bearings
  const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)

  const features: GeoJSON.Feature[] = []
  for (const t of thresholds) {
    if (!nearbyIcaos.has(t.icao)) continue
    const inbound = inboundBrg(t)
    const diff    = angleDiff(aircraftHeading, inbound)
    // Extend lineNm outward from the threshold in the inbound (approach) direction
    const end     = advancePosition(t.lat, t.lng, inbound, lineNm)
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[t.lng, t.lat], [end.lng, end.lat]] },
      properties: { icao: t.icao, mag_brg: effectiveMagBrg(t.mag_brg, t.true_brg), highlight: diff <= 30 },
    })
  }
  return { type: 'FeatureCollection', features }
}

// All clickable point-feature layers — hover cursor + click dispatch.
// Ordered by priority: aerodromes first, then navaids, waypoints, obstacles, landmarks.
const POINT_LAYERS = [
  'aerodromes-icon',
  'aerodromes-label',
  'navaids-vor-icon',
  'navaids-ndb-icon',
  'waypoints-mrp-icon',
  'waypoints-rp-icon',
  'obstacles-circle',
  'landmarks-icon',
]

// Airspace fill layers — queried for polygon click after point features.
const AIRSPACE_FILL_LAYERS = [
  'airspace-fill-c-ctr',
  'airspace-fill-c-tma',
  'airspace-fill-d',
  'airspace-fill-e',
  'airspace-fill-g',
  'airspace-fill-restricted',
  'airspace-fill-activity',
]

// Airspace edge layers (inset band, border, boundary label) -- a click
// within EDGE_HIT_PX of one of these picks that specific airspace out of
// the stacked popup. Derived from AIRSPACE_BASE_FILTERS so a new class
// only needs registering there.
const AIRSPACE_EDGE_LAYERS = Object.keys(AIRSPACE_BASE_FILTERS).filter((id) => !id.startsWith('airspace-fill-'))
const EDGE_HIT_PX = 8

/** Rough planar area of a lng/lat ring (cos-lat corrected), only used to
 *  rank shapes against each other -- smaller = more specific. */
function ringArea(ring: number[][] | undefined): number {
  if (!ring || ring.length < 3) return Infinity
  const cosLat = Math.cos((ring[0][1] * Math.PI) / 180)
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * cosLat) * ring[i][1] - (ring[i][0] * cosLat) * ring[j][1]
  }
  return Math.abs(a / 2)
}

/** Which single row of the airspace/NOTAM stack popup the pilot actually
 *  clicked (AirspacePopup's focusKey). The stack lists EVERY layer
 *  containing the point, so "the one clicked" is inferred:
 *   1. a rendered airspace edge (inset band/border/label) near the click --
 *      the inset band is drawn on the inside, so it's checked first -- or a
 *      point-only NOTAM marker under the cursor;
 *   2. otherwise the smallest shape containing the point (a CTR inside its
 *      TMA, a small NOTAM circle inside a big restricted area).
 *  Only candidates actually present in the popup's lists count, so a
 *  neighbouring airspace's border just outside the click never wins. */
function pickClickedAirspaceRow(
  map: maplibregl.Map,
  pt: maplibregl.Point,
  features: AirspaceFeature[],
  notamHits: RegionalNotamHit[],
): string | undefined {
  const airspaceKeys = new Set(features.map(airspaceRowKey))
  const notamKeys = new Set(notamHits.flatMap((h) => h.notams.map((n) => notamRowKey(n.nmsId))))

  const edgeLayers = AIRSPACE_EDGE_LAYERS.filter((id) => map.getLayer(id))
  if (edgeLayers.length > 0) {
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [pt.x - EDGE_HIT_PX, pt.y - EDGE_HIT_PX], [pt.x + EDGE_HIT_PX, pt.y + EDGE_HIT_PX],
    ]
    const hits = map.queryRenderedFeatures(box, { layers: edgeLayers })
    // Inset hits first, then border/label, each in MapLibre's topmost-first order.
    const ordered = [
      ...hits.filter((h) => h.layer.id.startsWith('airspace-inset-')),
      ...hits.filter((h) => !h.layer.id.startsWith('airspace-inset-')),
    ]
    for (const h of ordered) {
      const p = h.properties as Record<string, unknown>
      const key = airspaceRowKey({ name: String(p.name ?? ''), lower_ft: Number(p.lower_ft ?? 0), upper_ft: Number(p.upper_ft ?? 0) })
      if (airspaceKeys.has(key)) return key
    }
  }
  if (map.getLayer('notam-points-unclustered')) {
    for (const h of map.queryRenderedFeatures(pt, { layers: ['notam-points-unclustered'] })) {
      const key = notamRowKey(String((h.properties as Record<string, unknown>).nmsId ?? ''))
      if (notamKeys.has(key)) return key
    }
  }

  let best: { key: string; area: number } | undefined
  const consider = (key: string, area: number) => {
    if (!best || area < best.area) best = { key, area }
  }
  for (const f of features) consider(airspaceRowKey(f), ringArea(f.coords))
  for (const h of notamHits) if (h.notams[0]) consider(notamRowKey(h.notams[0].nmsId), ringArea(h.coords))
  return best?.key
}

// Layers that are valid snap targets during route planning.
// Obstacles and landmarks are not useful as route turning points.
const SNAP_LAYERS = [
  'aerodromes-icon', 'aerodromes-label',
  'navaids-vor-icon', 'navaids-ndb-icon',
  'waypoints-mrp-icon', 'waypoints-rp-icon',
  'obstacles-circle',
  'landmarks-icon',
  'user-waypoints-circle',
]

// Home airfield button icon (Lucide "home").
const LOCATE_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>'

/** In flight: after the pilot pans away, return to following the aircraft
 *  once the map has been left alone this long. A forgotten Re-center in
 *  flight otherwise leaves the map parked away from the aircraft. */
const FOLLOW_RETURN_MS = 15_000

/** Track-/course-up follow: aircraft sits this fraction of the map height
 *  below centre (0.25 × height = aircraft at 75% down the screen). */
const FOLLOW_LOOKAHEAD_RATIO = 0.25

const HOME_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>'

// Go Flying toggle button icon — same Ionicons "airplane-outline" glyph the
// native app's FlightModeSheet trigger uses, for icon parity across platforms.
const FLYING_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"><path d="M407.72,224c-3.4,0-14.79.1-18,.3l-64.9,1.7a1.83,1.83,0,0,1-1.69-.9L193.55,67.56A9,9,0,0,0,186.89,64H160l73,161a2.35,2.35,0,0,1-2.26,3.35l-121.69,1.8a8.06,8.06,0,0,1-6.6-3.1l-37-45c-3-3.9-8.62-6-13.51-6H33.08c-1.29,0-1.1,1.21-.75,2.43L52.17,249.9a16.3,16.3,0,0,1,0,11.9L32.31,333c-.59,1.95-.52,3,1.77,3H52c8.14,0,9.25-1.06,13.41-6.3l37.7-45.7a8.19,8.19,0,0,1,6.6-3.1l120.68,2.7a2.7,2.7,0,0,1,2.43,3.74L160,448h26.64a9,9,0,0,0,6.65-3.55L323.14,287c.39-.6,2-.9,2.69-.9l63.9,1.7c3.3.2,14.59.3,18,.3C452,288.1,480,275.93,480,256S452.12,224,407.72,224Z"/></svg>'

// Ruler tool button icon (Lucide "ruler").
const RULER_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.3 8.7 8.7 21.3c-1 1-2.5 1-3.4 0l-2.6-2.6c-1-1-1-2.5 0-3.4L15.3 2.7c1-1 2.5-1 3.4 0l2.6 2.6c1 1 1 2.5 0 3.4Z"/><path d="m7.5 10.5 2 2"/><path d="m10.5 7.5 2 2"/><path d="m13.5 4.5 2 2"/><path d="m4.5 13.5 2 2"/></svg>'

// Find a Destination button icon -- same Ionicons "search-outline" glyph the
// native app's FindDestinationSheet trigger uses, for icon parity across platforms.
const FIND_DEST_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-miterlimit="10"><path d="M221.09,64A157.09,157.09,0,1,0,378.18,221.09,157.1,157.1,0,0,0,221.09,64Z"/><line x1="338.29" y1="338.29" x2="448" y2="448"/></svg>'

// Airfield Brief button icon -- same Ionicons "newspaper-outline" glyph
// native's VicinityBriefSheet trigger uses, for icon parity across platforms.
const VICINITY_BRIEF_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32"><path d="M368,415.86V72a24.07,24.07,0,0,0-24-24H72A24.07,24.07,0,0,0,48,72V424a40.12,40.12,0,0,0,40,40H416" stroke-linejoin="round"/><path d="M416,464h0a48,48,0,0,1-48-48V128h72a24,24,0,0,1,24,24V416A48,48,0,0,1,416,464Z" stroke-linejoin="round"/><line x1="240" y1="128" x2="304" y2="128" stroke-linecap="round" stroke-linejoin="round"/><line x1="240" y1="192" x2="304" y2="192" stroke-linecap="round" stroke-linejoin="round"/><line x1="112" y1="256" x2="304" y2="256" stroke-linecap="round" stroke-linejoin="round"/><line x1="112" y1="320" x2="304" y2="320" stroke-linecap="round" stroke-linejoin="round"/><line x1="112" y1="384" x2="304" y2="384" stroke-linecap="round" stroke-linejoin="round"/><path d="M176,208H112a16,16,0,0,1-16-16V128a16,16,0,0,1,16-16h64a16,16,0,0,1,16,16v64A16,16,0,0,1,176,208Z" fill="currentColor" stroke="none"/></svg>'

// Route layer IDs toggled by the route Active/Inactive toggle (in RoutePlan's
// header, not a map button — see routeVisible below). Waypoint data is
// untouched — only display is affected.
const ROUTE_DISPLAY_LAYERS = [
  'route-line-layer',
  'route-waypoints-circle',
  'route-waypoints-label',
  'route-midpoints-layer',
  'route-leg-labels-layer',
  'alternate-line-layer',
  'alternate-point-layer',
]

// Popup state — discriminated union covering every interactive feature type.
type ActivePopup =
  | { kind: 'aerodrome'; props: AerodromeFeatureProps; lng: number; lat: number; x: number; y: number }
  | { kind: 'airspace';  features: AirspaceFeature[]; regionalNotams?: RegionalNotamHit[]; focusKey?: string; x: number; y: number }
  | { kind: 'point';     feature: PointFeature;        x: number; y: number }
  | { kind: 'whatshere'; items: WhatsHereItem[]; airspaceFeatures: AirspaceFeature[]; lng: number; lat: number; x: number; y: number }

// Apply altitude ceiling filter to all airspace layers on a ready map.
function applyAltitudeCeiling(map: maplibregl.Map, ceilingFt: number) {
  for (const [layerId, baseFilter] of Object.entries(AIRSPACE_BASE_FILTERS)) {
    if (map.getLayer(layerId)) {
      map.setFilter(layerId, buildAltitudeFilter(baseFilter, ceilingFt))
    }
  }
}

/** Extract the short identifier STORED as a snapped route-planning
 *  feature's `waypoint.name` -- this persists into the route (leg table,
 *  VirtualRadar waypoint-tick label, saved-route storage), so obstacles
 *  deliberately use the kind-only `obstacleWaypointName` here rather than
 *  formatObstacleName's elevation-suffixed fallback -- see
 *  extractSnapDisplayName below for the picker-only verbose form. */
function extractSnapName(feat: maplibregl.MapGeoJSONFeature): string {
  const p = feat.properties as Record<string, unknown>
  const id = feat.layer.id
  if (id.startsWith('aerodromes'))        return String(p.icao ?? p.name ?? 'AD')
  if (id.startsWith('navaids'))           return String(p.id   ?? p.name ?? 'NAV')
  if (id === 'obstacles-circle')          return obstacleWaypointName(p as { name?: string; kind?: string })
  if (id === 'landmarks-icon')            return formatLandmarkName(p as { name?: string; kind?: string })
  if (id === 'user-waypoints-circle')     return String(p.name ?? 'UWP')
  return String(p.id ?? p.name ?? 'WP')
}

/** Verbose form of the same feature's name, for SnapPicker's candidate list
 *  only -- NOT stored anywhere. Only obstacles differ from extractSnapName
 *  (elevation suffix helps tell apart two unnamed obstacles near the same
 *  click point, a one-off disambiguation need that extractSnapName's
 *  persisted short name deliberately drops). Every other feature type's
 *  display name is identical to its stored name, so this just delegates. */
function extractSnapDisplayName(feat: maplibregl.MapGeoJSONFeature): string {
  const id = feat.layer.id
  if (id === 'obstacles-circle') {
    const p = feat.properties as Record<string, unknown>
    return formatObstacleName(p as { name?: string; kind?: string; height_m?: number; elevation_ft?: number })
  }
  return extractSnapName(feat)
}

/** Interpolate a lat/lng at `targetNm` cumulative distance along a recorded track. */
function coordAlongTrack(track: TrackPoint[], targetNm: number): { lng: number; lat: number } {
  const NM_PER_DEG_LAT = 60.0
  let cumDist = 0
  for (let i = 1; i < track.length; i++) {
    const dLat = (track[i].lat - track[i - 1].lat) * NM_PER_DEG_LAT
    const dLng = (track[i].lng - track[i - 1].lng) * NM_PER_DEG_LAT *
      Math.cos((track[i - 1].lat + track[i].lat) * 0.5 * Math.PI / 180)
    const segDist = Math.sqrt(dLat * dLat + dLng * dLng)
    if (cumDist + segDist >= targetNm) {
      const t = segDist > 0 ? (targetNm - cumDist) / segDist : 0
      return {
        lat: track[i - 1].lat + t * (track[i].lat - track[i - 1].lat),
        lng: track[i - 1].lng + t * (track[i].lng - track[i - 1].lng),
      }
    }
    cumDist += segDist
  }
  return { lat: track[track.length - 1].lat, lng: track[track.length - 1].lng }
}

/** Short kind badge for disambiguation picker. */
function extractSnapKind(feat: maplibregl.MapGeoJSONFeature): string {
  const p = feat.properties as Record<string, unknown>
  const id = feat.layer.id
  if (id.startsWith('aerodromes'))        return 'AD'
  if (id === 'navaids-vor-icon')          return 'VOR'
  if (id === 'navaids-ndb-icon')          return 'NDB'
  if (id === 'waypoints-mrp-icon')        return 'MRP'
  if (id === 'waypoints-rp-icon')         return 'RP'
  if (id === 'obstacles-circle')          return 'OBS'
  if (id === 'landmarks-icon')            return 'LMK'
  if (id === 'user-waypoints-circle')     return 'UWP'
  return String(p.wp_type ?? 'WP')
}

// Safely parse a GeoJSON property that may be a JSON string or already parsed.
function parseJsonProp<T>(val: unknown, fallback: T): T {
  if (typeof val === 'string') {
    try { return JSON.parse(val) as T } catch { return fallback }
  }
  return (val as T) ?? fallback
}

// Stable empty input for the ruler's useWeatherAlongRoute instance while the
// ruler profile is hidden -- a fresh [] per render would re-run its effect.
const NO_WAYPOINTS: RouteWaypoint[] = []

export default function MapView({ auth }: { auth: AuthState }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const rulerBtnRef = useRef<HTMLButtonElement | null>(null)
  // Active altitude-filter range, shown beside the scale bar so it's always
  // visible that airspace above the ceiling is hidden (the slider itself
  // lives in a collapsible drawer section).
  const homeBtnRef = useRef<HTMLButtonElement | null>(null)
  // ── Location button: 'off' | 'passive' outside Go Flying (Follow is the
  // flying-mode followAircraft state). Passive = own-position dot, camera
  // only moves on an explicit tap. See usePassivePosition.
  const [locMode, setLocMode] = useState<'off' | 'passive'>('off')
  const locateBtnRef = useRef<HTMLButtonElement | null>(null)
  const locateClickRef = useRef<() => void>(() => {})
  const pendingLocateCenterRef = useRef(false)
  const planningModeRef = useRef(false)
  const routeWaypointsRef = useRef<RouteWaypoint[]>([])
  const rulerModeRef = useRef(false)
  const rulerPointsRef = useRef<RouteWaypoint[]>([])
  const placingUserWpRef = useRef(false)
  // Idle map cursor by active tool. '' inherits the map's own grab hand;
  // tools that turn a click into an action (measure, add waypoint, place a
  // user waypoint) show a crosshair. Hover cursors over handles/features are
  // set by their own handlers and fall back to this. While the map is being
  // panned the cursor is 'grabbing' whichever tool is active (dragstart/end).
  const baseCursor = (): string =>
    (rulerModeRef.current || planningModeRef.current || placingUserWpRef.current) ? 'crosshair' : ''
  const hasInitialCenteredRef = useRef(false)
  // Non-null while a midpoint drag-insert is in progress.
  const dragInsertRef = useRef<{ legIndex: number; cur: maplibregl.LngLat } | null>(null)
  // Non-null while an existing waypoint drag-move is in progress.
  const dragMoveRef = useRef<{ wpIndex: number; cur: maplibregl.LngLat; moved: boolean } | null>(null)
  // Long-press timer for leg-line touch (fires at 500 ms, auto-inserts WP).
  const legLongPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Suppresses the next map click event after a drag-move mousedown fires.
  const suppressNextClickRef = useRef(false)
  const [visibility, setVisibilityGroup] = useLayerVisibility()
  const [ceilingFt, setCeilingFt] = useAirspaceCeiling()
  const [activePopup, setActivePopup] = useState<ActivePopup | null>(null)
  // Escape closes the open feature popup. Skipped while typing (Escape in a
  // search field clears/closes that field instead) and when another handler
  // already consumed it (e.g. the drag-cancel handler in the map-init effect).
  useEffect(() => {
    if (!activePopup) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      setActivePopup(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activePopup])

  // Wind-derived favored/severity state for whichever aerodrome's popup is
  // currently open, reported up by AerodromePopup (see onRunwayWind prop) so
  // the map's own 'runway-threshold-label' layer can highlight the same
  // favored runway end, not just inside the popup panel.
  const [runwayWindHighlight, setRunwayWindHighlight] =
    useState<{ icao: string; ends: RunwayWindEnd[] } | null>(null)

  const handleRunwayWind = useCallback((icao: string, ends: RunwayWindEnd[]) => {
    setRunwayWindHighlight(ends.length > 0 ? { icao, ends } : null)
  }, [])

  // Airfield Brief's NOTAMs tab "MAP" jump-to action (RegionalNotamsPanel,
  // embedded in VicinityBriefPanel) -- flies to the NOTAM's own geometry
  // and opens it in the same rich airspace-style popup a map click on its
  // circle/polygon produces (shape thumbnail + details), rather than a
  // plain text-only popup with no visual context.
  const handleShowNotamOnMap = useCallback((notam: NotamItem) => {
    const map = mapRef.current
    if (!map) return
    const ring = notamItemRing(notam)
    const openPopupAt = (lng: number, lat: number) => {
      map.once('moveend', () => {
        const pt = map.project([lng, lat])
        setActivePopup({ kind: 'airspace', features: [], regionalNotams: [{ notams: [notam], coords: ring }], focusKey: notamRowKey(notam.nmsId), x: pt.x, y: pt.y })
      })
    }
    if (ring) {
      const bounds = ringBounds(ring)
      map.fitBounds(bounds, { padding: 100, maxZoom: 12, duration: 1000 })
      const [[minLng, minLat], [maxLng, maxLat]] = bounds
      openPopupAt((minLng + maxLng) / 2, (minLat + maxLat) / 2)
    } else if (notam.lat !== null && notam.lon !== null) {
      map.flyTo({ center: [notam.lon, notam.lat], zoom: 10, speed: 1.4 })
      openPopupAt(notam.lon, notam.lat)
    }
  }, [])

  // Apply/clear the highlight expressions on the map whenever it changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getLayer('runway-threshold-label')) return
    const expr = buildRunwayWindHighlight(
      runwayWindHighlight?.icao ?? '',
      runwayWindHighlight?.ends ?? [],
    )
    map.setPaintProperty('runway-threshold-label', 'text-color', expr.color as ExpressionSpecification | string)
    map.setPaintProperty('runway-threshold-label', 'text-halo-color', expr.haloColor as ExpressionSpecification | string)
    map.setLayoutProperty('runway-threshold-label', 'text-size', expr.size as ExpressionSpecification)
    map.setPaintProperty('runway-threshold-label', 'text-opacity', expr.opacity as ExpressionSpecification)
  }, [runwayWindHighlight])
  const [region, setRegion] = useState(DEFAULT_REGION)
  const [basemapMode, setBasemapMode] = useState<'vector' | 'satellite'>('vector')
  const [planningMode, setPlanningMode] = useState(false)
  // Route activate/deactivate — hides the drawn route on the map without
  // touching stored waypoints. Independent of planningMode/Clear.
  const [routeVisible, setRouteVisible] = useState(true)
  const [rulerMode, setRulerMode] = useState(false)
  const [rulerPoints, setRulerPoints] = useState<RouteWaypoint[]>([])
  const [placingUserWp, setPlacingUserWp] = useState(false)
  const [pendingUserWpCoords, setPendingUserWpCoords] = useState<{ lng: number; lat: number } | null>(null)
  const [folderVisibility, setFolderVisibility] = useState<Record<string, boolean>>(() => {
    try {
      const v = localStorage.getItem('ovfr:uwp:folderVis')
      return v ? (JSON.parse(v) as Record<string, boolean>) : {}
    } catch { return {} }
  })
  const [homeAirfield, setHomeAirfield] = useHomeAirfield()
  const [units, setUnits] = useUnits()
  const [theme, setTheme] = useTheme()
  const [autoZoom, setAutoZoom] = useAutoZoom()
  const autoZoomRef = useRef(autoZoom)
  useEffect(() => { autoZoomRef.current = autoZoom }, [autoZoom])
  const [trajectoryMode, setTrajectoryMode] = useTrajectoryMode()
  const trajectoryModeRef = useRef(trajectoryMode)
  useEffect(() => { trajectoryModeRef.current = trajectoryMode }, [trajectoryMode])
  const [airspaceWarnLookahead, setAirspaceWarnLookahead] = useAirspaceWarnLookahead()
  const [airspaceWarnVerticalFt, setAirspaceWarnVerticalFt] = useAirspaceWarnVerticalFt()
  const [terrainColoring, setTerrainColoring] = useTerrainColoring()
  const [trafficVertFilter, setTrafficVertFilter] = useTrafficVertFilter()
  const [parkTimeout, setParkTimeout] = useParkTimeout()
  const [alternate, _setAlternate] = useAlternate()
  const [routeWaypoints, setRouteWaypoints, legOverrides, setLegOverrides, loadRouteIntoMap, routeAircraftId, setRouteAircraftId, activeRouteId, setActiveRouteId, routeUndo] = usePersistedRoute()
  // Computed once here (not inside SideDrawer) so VirtualRadar's wind-arrow/
  // cloud-layer overlay and SideDrawer's Weather-Along-Route panel share the
  // same fetched station list instead of each independently hitting
  // /api/weather for the same route.
  const routeWeatherStations = useWeatherAlongRoute(routeWaypoints)
  // Separate lookup along the Map Ruler line -- passing the planned route's
  // stations to the ruler's VirtualRadar projected them onto an unrelated
  // line. Only enabled while the ruler profile is showing; the aerodrome
  // list itself is shared with the instance above (module-level cache).
  const showRulerProfile = rulerMode && rulerPoints.length === 2
  const rulerWeatherStations = useWeatherAlongRoute(
    showRulerProfile ? rulerPoints : NO_WAYPOINTS,
    showRulerProfile,
  )
  // Regular-interval wind samples (nearest METAR-or-model-wind, independent
  // of aerodrome positions) -- fills the gaps between routeWeatherStations'
  // real-station markers, which only ever exist wherever an aerodrome
  // happens to sit. Same lift-to-MapView reasoning as routeWeatherStations
  // above: one fetch shared by every VirtualRadar instance.
  const routeTotalNm = routeWaypoints.length >= 2 ? distanceAlongRouteNm(routeWaypoints, routeWaypoints[routeWaypoints.length - 1]) : 0
  const routeWindSamples = useWindAlongRoute(routeWaypoints, routeTotalNm)
  const { waypoints: userWaypoints, saveWaypoint: saveUserWaypoint, deleteWaypoint: deleteUserWaypoint, renameWaypoint: renameUserWaypoint, moveToFolder: moveUserWpFolder } = useUserWaypoints()
  const [snapPicker, setSnapPicker] = useState<{
    candidates: SnapCandidate[]
    x: number
    y: number
    /** When set, inserts the picked WP at this index rather than appending. */
    insertAt?: number
    /** When true, replaces the waypoint at insertAt instead of inserting. */
    replaceMode?: boolean
  } | null>(null)
  // Aircraft profile selection — persisted to RxDB
  const { profiles: aircraftProfiles } = useAircraftProfiles()
  const [selectedAircraftId, setSelectedAircraftId] = useSelectedAircraftId()
  const selectedAircraftProfile = aircraftProfiles.find((p) => p.id === selectedAircraftId) ?? undefined
  // Keep the current working route's stored aircraftId in sync with the global selection.
  useEffect(() => {
    if ((selectedAircraftId ?? '') !== routeAircraftId) setRouteAircraftId(selectedAircraftId ?? '')
  }, [selectedAircraftId, routeAircraftId, setRouteAircraftId])
  // Ref so the map's styledata handler can always read the latest profile value.
  const selectedAircraftProfileRef = useRef(selectedAircraftProfile)
  selectedAircraftProfileRef.current = selectedAircraftProfile
  // Set to true after INIT_CALLBACK finishes adding all route/alternate sources+layers.
  // More reliable than isStyleLoaded() for syncing route data after RxDB loads.
  const [mapReady, setMapReady] = useState(false)
  // Map opened with a route already restored from storage: fit it into view once.
  const initialRouteFitRef = useRef(false)
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || initialRouteFitRef.current || routeWaypoints.length < 2) return
    initialRouteFitRef.current = true
    const lngs = routeWaypoints.map((w) => w.lng)
    const lats = routeWaypoints.map((w) => w.lat)
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 80, maxZoom: 13, duration: 800 },
    )
  }, [mapReady, routeWaypoints])

  // ── Go Flying (GPS / simulation) ─────────────────────────────────────────
  const {
    mode:     flyingMode,
    position: gpsPosition,
    startGps,
    startSim,
    startExt,
    stop:     stopFlying,
    teleport,
    setSimTarget,
  } = useGoFlying(routeWaypoints)

  // Satellite imagery is a planning-only basemap. Its provider's terms class
  // aircraft navigation as a "High Risk Activity" the imagery is not intended
  // for, and it's the wrong basemap for reading airspace in flight anyway --
  // so entering any flight mode forces vector and LayerPanel greys the
  // option out until the flight ends. Mirrored in native's MapScreen.
  const satelliteLocked = flyingMode !== 'off'
  useEffect(() => {
    if (satelliteLocked && basemapMode === 'satellite') setBasemapMode('vector')
  }, [satelliteLocked, basemapMode])
  // Airfield Brief panel's aerodrome picker -- route-buffer > GPS-radius >
  // home-airfield fallback, see useVicinityAerodromes.ts doc comment.
  const vicinityAerodromes = useVicinityAerodromes({
    waypoints: routeWaypoints,
    position: gpsPosition,
    routeVisible,
    homeIcao: homeAirfield?.icao ?? null,
  })
  const nearbyFreqs = useNearbyFrequencies(gpsPosition)
  // GPS-derived vertical speed — see useGpsVerticalSpeed's header for why
  // this is explicitly a lower-quality fallback vs. native's baro/vario
  // tiering, kept only active while actually flying (mirrors gpsPosition's
  // own flyingMode gating used everywhere else in this file).
  const gpsVSpeedFpm = useGpsVerticalSpeed(flyingMode !== 'off' ? gpsPosition : null)
  const [mapOrientation, setMapOrientation] = useState<MapOrientation>('north')
  const [followAircraft, setFollowAircraft] = useState(false)
  const [showModePicker, setShowModePicker] = useState(false)
  const [showExtForm,    setShowExtForm]    = useState(false)
  const [profileOpen,    setProfileOpen]    = useState(false)
  const [extWsUrl,       setExtWsUrl]       = useState(() => localStorage.getItem('ovfr:extWsUrl') ?? 'ws://localhost:5104')
  const [extWsError,     setExtWsError]     = useState<string | null>(null)
  const [showDirectTo,   setShowDirectTo]   = useState(false)
  const [showFindDest,   setShowFindDest]   = useState(false)
  const [showVicinityBrief, setShowVicinityBrief] = useState(false)
  // ICAO dismissed by the user; resets when a different aerodrome enters range
  const [briefDismissed, setBriefDismissed] = useState<string | null>(null)
  const [showPlog, setShowPlog] = useState(false)
  // In-flight route adjustment mode: unlocks drag-move/insert without full planning mode
  const [routeAdjustMode, setRouteAdjustMode] = useState(false)
  // Edit sessions run while route editing is possible; leaving planning /
  // adjust mode applies pending changes (nothing is discarded silently).
  const { setEditSessionArmed, applyEditSession } = routeUndo
  useEffect(() => {
    const armed = planningMode || routeAdjustMode
    setEditSessionArmed(armed)
    if (!armed) applyEditSession()
  }, [planningMode, routeAdjustMode, setEditSessionArmed, applyEditSession])
  // Same lock as the waypoint-drag handlers: while flying, route edits
  // (including undo/redo) need the explicit in-flight adjust unlock.
  const routeEditLocked = flyingMode !== 'off' && !routeAdjustMode
  // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo -- ignored while
  // typing so text fields keep their native undo.
  useEffect(() => {
    if (routeEditLocked) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); routeUndo.undo() }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); routeUndo.redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [routeEditLocked, routeUndo.undo, routeUndo.redo])
  const routeAdjustModeRef = useRef(false)
  useEffect(() => { routeAdjustModeRef.current = routeAdjustMode }, [routeAdjustMode])
  // Small context menu shown when tapping a waypoint in adjust mode
  const [wpMenu, setWpMenu] = useState<{ wpIdx: number; x: number; y: number } | null>(null)
  // Context menu shown after long-press on a route leg
  const [legMenu, setLegMenu] = useState<{ legIndex: number; lngLat: maplibregl.LngLat; x: number; y: number } | null>(null)
  // NM along the route where the VirtualRadar hover cursor is — drives a map crosshair marker
  const [profileCursorNm, setProfileCursorNm] = useState<number | null>(null)
  // Stable ref to the setter so map event handlers can call it without stale closures
  const setProfileCursorNmRef = useRef(setProfileCursorNm)
  // Historical log track — declared here so the cursor effect below can reference it
  const [selectedLogId,    setSelectedLogId]    = useState<string | null>(null)
  const [selectedLogTrack, setSelectedLogTrack] = useState<TrackPoint[]>([])

  // ── Look-ahead VirtualRadar for unplanned flight ──────────────────────────
  // While flying without a planned route, synthesise a 2-waypoint route from
  // the current GPS position along the current ground track for LOOKAHEAD_NM.
  // Recomputed when heading changes ≥10°, position moves ≥1 NM, or 20 s elapse.
  // (Tightened from ≥15°/≥3 NM/60 s — that was stale enough that obstacles
  // near the aircraft's current position, and the chart's own position
  // marker, visibly lagged reality for up to a minute/3 NM while flying.)
  // The terrain fetch inside VirtualRadar is auto-aborted/restarted on route change.
  const LOOKAHEAD_NM = 30
  const [lookaheadWaypoints,   setLookaheadWaypoints]   = useState<RouteWaypoint[]>([])
  const [lookaheadHeadingDeg,  setLookaheadHeadingDeg]  = useState(0)
  const lookaheadRef = useRef<{ lat: number; lng: number; trackDeg: number; ts: number }>(
    { lat: 0, lng: 0, trackDeg: -999, ts: 0 },
  )
  useEffect(() => {
    if (flyingMode === 'off' || routeWaypoints.length >= 2 || !gpsPosition) {
      if (lookaheadWaypoints.length > 0) setLookaheadWaypoints([])
      return
    }
    const last   = lookaheadRef.current
    const now    = Date.now()
    const dPos   = distanceNm({ lat: last.lat, lng: last.lng }, { lat: gpsPosition.lat, lng: gpsPosition.lng })
    const rawDHdg = Math.abs(gpsPosition.trackDeg - last.trackDeg)
    const dHdg   = Math.min(rawDHdg, 360 - rawDHdg)
    const dTime  = now - last.ts
    // Skip update if nothing significant changed yet
    if (last.ts > 0 && dPos < 1 && dHdg < 10 && dTime < 20_000) return
    const end = advancePosition(gpsPosition.lat, gpsPosition.lng, gpsPosition.trackDeg, LOOKAHEAD_NM)
    lookaheadRef.current = { lat: gpsPosition.lat, lng: gpsPosition.lng, trackDeg: gpsPosition.trackDeg, ts: now }
    setLookaheadWaypoints([
      { lat: gpsPosition.lat, lng: gpsPosition.lng, name: 'Position' },
      { lat: end.lat,         lng: end.lng,         name: `Hdg ${Math.round(gpsPosition.trackDeg)}°` },
    ])
    setLookaheadHeadingDeg(gpsPosition.trackDeg)
  // gpsPosition reference changes every tick — only re-run when the values that
  // matter for the threshold check change, not on every position update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyingMode, routeWaypoints.length, gpsPosition])
  // NM along the planned route where the aircraft currently is — drives the
  // live position marker on the VirtualRadar chart. Only computed during flight.
  const aircraftDistNm = useMemo(() => {
    if (flyingMode === 'off' || !gpsPosition || routeWaypoints.length < 2) return undefined
    return distanceAlongRouteNm(routeWaypoints, gpsPosition)
  }, [flyingMode, gpsPosition, routeWaypoints])
  // Lateral deviation from the planned line — mirrors native's identical
  // crossTrackNm wiring. VirtualRadar's terrain/airspace/MSA data is only
  // ever sampled along the *planned* route, so this drives an in-chart badge
  // once the aircraft has meaningfully diverged from it.
  const crossTrackNm = useMemo(() => {
    if (flyingMode === 'off' || !gpsPosition || routeWaypoints.length < 2) return undefined
    return routeCrossTrackNm(routeWaypoints, gpsPosition)
  }, [flyingMode, gpsPosition, routeWaypoints])

  // Aircraft's live progress along the synthesised look-ahead route.
  // Previously hardcoded to 0 when passed to VirtualRadar, which pinned the
  // marker at the route-start point forever — lookaheadWaypoints[0] is only
  // re-snapped to the current position every 1 NM/10°/20 s, so between
  // snaps the aircraft visibly moves along the ground but the chart marker
  // stayed frozen at the left edge. Recomputing live against the (possibly
  // slightly stale) lookahead line keeps the marker tracking real motion,
  // since the aircraft continues along the same track the line was
  // extended from.
  const lookaheadDistNm = useMemo(() => {
    if (!gpsPosition || lookaheadWaypoints.length < 2) return 0
    return distanceAlongRouteNm(lookaheadWaypoints, gpsPosition)
  }, [gpsPosition, lookaheadWaypoints])

  // Update the profile-cursor map marker when the VirtualRadar / LiveTrackChart hover changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('profile-cursor') as GeoJSONSource | undefined
    if (!src) return
    if (profileCursorNm == null) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    let coord: { lng: number; lat: number } | null = null
    // Past-log review takes priority: cursor must follow the violet track, not the planned route.
    if (selectedLogTrack.length >= 2) {
      coord = coordAlongTrack(selectedLogTrack, profileCursorNm)
    } else if (lookaheadWaypoints.length >= 2) {
      // Hovering the look-ahead chart: place cursor on the map ahead of the aircraft.
      coord = coordinateAlongRouteNm(lookaheadWaypoints, profileCursorNm)
    } else if (routeWaypoints.length >= 2) {
      coord = coordinateAlongRouteNm(routeWaypoints, profileCursorNm)
    }
    if (coord) {
      src.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [coord.lng, coord.lat] }, properties: {} }],
      })
    } else {
      src.setData({ type: 'FeatureCollection', features: [] })
    }
  }, [profileCursorNm, routeWaypoints, selectedLogTrack, lookaheadWaypoints, mapReady])

  // Swap the aircraft map icon whenever the selected profile (or map readiness) changes.
  // The styledata handler handles the basemap-swap case via selectedAircraftProfileRef.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    const url = (selectedAircraftProfile ? aircraftIconUrl(selectedAircraftProfile.category) : null)
      ?? '/aircraft_icons/cessna.svg'
    registerAircraftImageFromSvg(map, url).catch(console.warn)
  }, [selectedAircraftProfile, mapReady])
  const [activeWpIdx,    setActiveWpIdx]    = useState(1)
  const flyingModeRef   = useRef<FlyingMode>('off')

  // ── Location button behaviour (see locMode above) ─────────────────────
  const { position: passivePos, denied: locDenied } = usePassivePosition(locMode === 'passive' && flyingMode === 'off')
  // Startup: if permission was already granted, show the dot straight away
  // (no prompt, camera untouched). Otherwise nothing until the user taps.
  useEffect(() => {
    let cancelled = false
    geolocationAlreadyGranted().then(ok => { if (ok && !cancelled) setLocMode(m => (m === 'off' ? 'passive' : m)) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => { if (locDenied) setLocMode('off') }, [locDenied])

  locateClickRef.current = () => {
    const map = mapRef.current
    if (flyingModeRef.current !== 'off') {
      // Flying: the button is the Follow toggle's re-centre.
      setFollowAircraft(true)
      const pos = gpsPositionRef.current
      if (pos && map) map.flyTo({ center: [pos.lng, pos.lat], speed: 2 })
      return
    }
    if (locMode === 'off') {
      setLocMode('passive')
      pendingLocateCenterRef.current = true   // centre once on first fix
      return
    }
    if (!map || !passivePos) { pendingLocateCenterRef.current = true; return }
    // Already centred on the dot -> a further tap turns location off.
    const c = map.getCenter()
    if (distanceNm({ lat: c.lat, lng: c.lng }, passivePos) * 1852 < 50) {
      setLocMode('off')
    } else {
      map.flyTo({ center: [passivePos.lng, passivePos.lat], zoom: Math.max(map.getZoom(), 11), speed: 1.6 })
    }
  }

  useEffect(() => {
    const map = mapRef.current
    if (!map || !passivePos || !pendingLocateCenterRef.current) return
    pendingLocateCenterRef.current = false
    map.flyTo({ center: [passivePos.lng, passivePos.lat], zoom: Math.max(map.getZoom(), 11), speed: 1.6 })
  }, [passivePos])

  // Own-position dot (DOM marker: independent of the style, so it survives
  // basemap swaps without touching sources/layers). Hidden while flying --
  // the aircraft symbol takes over then.
  const posMarkerRef = useRef<maplibregl.Marker | null>(null)
  useEffect(() => {
    const map = mapRef.current
    const show = mapReady && map && passivePos && flyingMode === 'off'
    if (!show) { posMarkerRef.current?.remove(); posMarkerRef.current = null; return }
    if (!posMarkerRef.current) {
      const el = document.createElement('div')
      el.className = 'ovfr-own-position'
      el.innerHTML = '<div class="ovfr-own-position-heading"></div><div class="ovfr-own-position-dot"></div>'
      el.title = 'Your position'
      posMarkerRef.current = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat([passivePos.lng, passivePos.lat]).addTo(map)
    }
    const m = posMarkerRef.current
    m.setLngLat([passivePos.lng, passivePos.lat])
    const heading = m.getElement().querySelector<HTMLElement>('.ovfr-own-position-heading')
    if (heading) heading.style.display = passivePos.headingDeg === null ? 'none' : ''
    m.setRotation(passivePos.headingDeg ?? 0)
  }, [passivePos, mapReady, flyingMode])

  // Button appearance per state.
  useEffect(() => {
    const btn = locateBtnRef.current
    if (!btn) return
    const flying = flyingMode !== 'off'
    const on = flying ? followAircraft : locMode === 'passive'
    btn.title = flying
      ? (followAircraft ? 'Following aircraft' : 'Re-centre on aircraft (returns automatically after 15 s)')
      : locMode === 'off'
        ? (locDenied ? 'Location permission denied' : 'Show my position')
        : 'Showing my position — tap to centre, tap again when centred to turn off'
    btn.style.color = on ? 'var(--accent-blue)' : ''
    btn.setAttribute('aria-pressed', String(on))
    btn.setAttribute('aria-label', btn.title)
  }, [locMode, locDenied, followAircraft, flyingMode, mapReady])
  const gpsPositionRef  = useRef<GpsPosition | null>(null)
  const aircraftDragRef = useRef(false)
  const flyingBtnRef     = useRef<HTMLButtonElement | null>(null)
  const findDestBtnRef   = useRef<HTMLButtonElement | null>(null)
  // Cache of all runway threshold entries, loaded once from se-runway-thresholds.geojson
  const runwayThresholdsRef = useRef<ThresholdEntry[]>([])
  // Cache of every towered aerodrome's coords + hours, loaded once from
  // se-aerodromes.geojson -- used to periodically recolor 'aerodromes-atc-ring'
  // (see the effect below). Cached independently of the ofm-aerodromes map
  // source so the ring color is correct even for airports currently outside
  // the viewport, not just whatever's been tile-loaded.
  const toweredAerodromesRef = useRef<{ icao: string; lat: number; lng: number; hours: AtcHoursEntry[] }[]>([])
  const stopFlyingRef   = useRef(stopFlying)
  const teleportRef     = useRef(teleport)
  const setSimTargetRef = useRef(setSimTarget)
  // Auto-zoom: tracks whether we've applied the takeoff zoom so we don't re-apply.
  const autoZoomPhaseRef = useRef<'idle' | 'takeoff' | 'cruise'>('idle')
  const autoZoomTargetRef = useRef<{ zoom: number; until: number } | null>(null)

  // Position report — nearest aviation feature to current GPS position
  const [trackedPoint, setTrackedPoint] = useState<TrackedPoint | null>(null)
  const nearestFeature = useNearestFeature(flyingMode !== 'off' ? gpsPosition : null, trackedPoint)
  const { alerts: airspaceAlerts,     dismiss: dismissAlert }       = useAirspaceWarnings(flyingMode !== 'off' ? gpsPosition : null, airspaceWarnLookahead, airspaceWarnVerticalFt)
  const { notifications: airspaceNotifications }                     = useAirspaceNotifications(flyingMode !== 'off' ? gpsPosition : null)
  const { alerts: obstructionAlerts,  dismiss: dismissObstruction } = useObstructionWarnings(flyingMode !== 'off' ? gpsPosition : null)
  const { alerts: airfieldAlerts,     dismiss: dismissAirfield }    = useAirfieldProximity(flyingMode !== 'off' ? gpsPosition : null, routeWaypoints)
  const airfieldBrief = useAirfieldBrief(flyingMode !== 'off' ? gpsPosition : null, routeWaypoints, activeWpIdx)

  // Geofenced, automatic favoured-runway-end highlight -- same map paint
  // (runwayWindHighlight/buildRunwayWindHighlight above) as an open
  // AerodromePopup already drives, but triggered by GPS/Simulate position
  // alone (bigger radius than airfieldBrief's own 3/8 NM -- see
  // useAerodromeWxHighlight's header) so it works with no popup open at
  // all. Disabled while an aerodrome popup IS open -- that popup's own
  // onRunwayWind effect is the sole driver of runwayWindHighlight then, so
  // the two never race to write it; closing the popup hands control back
  // (this hook re-asserts from its own per-ICAO cache with no new fetch
  // needed if the cache already has that aerodrome).
  const aerodromePopupOpen = activePopup?.kind === 'aerodrome'
  const geofenceWxHighlight = useAerodromeWxHighlight(
    flyingMode !== 'off' ? gpsPosition : null,
    routeWaypoints,
    activeWpIdx,
    !aerodromePopupOpen,
  )
  useEffect(() => {
    if (aerodromePopupOpen) return
    setRunwayWindHighlight(geofenceWxHighlight)
  }, [geofenceWxHighlight, aerodromePopupOpen])
  const { manifest, hasUpdate, checking, markSeen, refresh: refreshManifest, outdatedAirac, currentAirac } = useDataManifest()
  // Session-only dismissal, keyed on the exact outdated set: a newly
  // superseded cycle (or another country going stale) re-shows the banner.
  const outdatedAiracKey = outdatedAirac.map(o => `${o.country}:${o.cycle}`).join(',')
  const [dismissedAiracKey, setDismissedAiracKey] = useState<string | null>(null)
  const isOnline = useOnlineStatus()
  const plogData = useLivePlog(flyingMode !== 'off' ? gpsPosition : null, flyingMode, routeWaypoints, activeWpIdx)
  // Reset the dismiss when a different aerodrome becomes active
  useEffect(() => {
    if (airfieldBrief && briefDismissed && airfieldBrief.icao !== briefDismissed) {
      setBriefDismissed(null)
    }
  }, [airfieldBrief?.icao])

  // Close plog + adjust mode when flying stops
  useEffect(() => {
    if (flyingMode === 'off') {
      setShowPlog(false)
      setRouteAdjustMode(false)
      setWpMenu(null)
    }
  }, [flyingMode])

  // Sync terrain coloring settings → map paint properties.
  // In-flight: use live GPS altitude as the reference so colour bands
  // update continuously as the aircraft climbs / descends.
  // On ground / planning: use the manually configured refAltFt.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (!terrainColoring.enabled || basemapMode === 'satellite') {
      map.setLayoutProperty('terrain-color', 'visibility', 'none')
      return
    }
    const flying = flyingMode !== 'off'
    const refAltFt = flying && gpsPosition && gpsPosition.altFt > 0
      ? gpsPosition.altFt
      : terrainColoring.refAltFt
    map.setPaintProperty('terrain-color', 'color-relief-color', buildTerrainColorExpr(refAltFt))
    map.setLayoutProperty('terrain-color', 'visibility', 'visible')
  }, [terrainColoring, mapReady, flyingMode, gpsPosition?.altFt, basemapMode])

  // Flight log — live in-flight track
  const { liveTrack } = useFlightLog(
    flyingMode !== 'off' ? gpsPosition : null,
    flyingMode,
    selectedAircraftId ?? '',
    selectedAircraftProfile?.registration ?? '',
    nearestFeature?.kind === 'aerodrome' ? nearestFeature.name : null,
    parkTimeout * 1000,
  )

  // ── ADS-B traffic (OpenSky Network via server SSE) ──────────────────────
  const trafficEnabled = (visibility['traffic'] ?? false) && !!auth.user
  const trafficTargets = useTraffic({
    ownAltFt: gpsPosition?.altFt ?? null,
    enabled:  trafficEnabled && mapReady,
  })
  // Ref so the map click handler (registered once) always sees latest targets.
  const trafficTargetsRef = useRef(trafficTargets)
  useEffect(() => { trafficTargetsRef.current = trafficTargets }, [trafficTargets])

  // ── Regional NOTAMs (FIR-wide, ad-hoc circles from coordinates+radius) ──
  // Fetched independent of the 'notamCircles' layer-visibility toggle --
  // that toggle only controls whether notam-circles/notam-polygons/
  // notam-points *draw* on the map (via LAYER_GROUPS' generic layerIds
  // visibility application), same as any other layer group. The underlying
  // data must keep flowing regardless, since AirspacePopup's inline NOTAM
  // match, the airspace-vs-NOTAM designator match (notamAirspaceMatches
  // below), useNotamWarnings, and RegionalNotamsPanel all depend on it --
  // none of those are the map layer itself, and a user hiding the on-map
  // circles to declutter shouldn't also go blind to the same NOTAMs
  // everywhere else.
  const regionalNotamsEnabled = !!auth.user
  // Full list (lists/popups apply their own relevance filtering so they can
  // say what they hid); map layers + in-flight warnings use the VFR-filtered
  // one per the shared "VFR only" preference.
  const regionalNotamsAll = useRegionalNotams(regionalNotamsEnabled && mapReady)
  const notamVfrOnly = useNotamVfrOnly()
  const regionalNotams = useMemo(
    () => (notamVfrOnly ? regionalNotamsAll.filter(n => !isIfrOnly(n)) : regionalNotamsAll),
    [regionalNotamsAll, notamVfrOnly],
  )
  const regionalNotamsRef = useRef(regionalNotams)
  useEffect(() => { regionalNotamsRef.current = regionalNotams }, [regionalNotams])

  // ── Ambient wind arrows (grid overlay of speed/direction wind barbs) ────────
  // Surface wind while on the ground/unknown altitude, live GPS altitude
  // once flying — same convention fetchWind itself documents.
  const windEnabled = visibility['wind'] ?? false
  const windGridFC = useWindGrid(
    mapReady ? mapRef.current : null,
    windEnabled,
    flyingMode !== 'off' ? (gpsPosition?.altFt ?? null) : null,
  )
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('wind-grid') as import('maplibre-gl').GeoJSONSource | undefined
    src?.setData(windGridFC)
  }, [windGridFC, mapReady])

  // Match regional NOTAMs to charted restricted/danger area polygons by
  // designator code (e.g. "ESD873") -- see useNotamAirspaceMatch.ts. Powers
  // both the polygon highlight layer below and AirspacePopup's inline NOTAM
  // display (matchedAirspaceRef, used in the click handler further down).
  const { matches: notamAirspaceMatches, matchedNotamIds } = useNotamAirspaceMatch(regionalNotams)
  const matchedAirspaceRef = useRef(notamAirspaceMatches)
  useEffect(() => { matchedAirspaceRef.current = notamAirspaceMatches }, [notamAirspaceMatches])

  // Feed regional NOTAM circles into the 'notam-circles' GeoJSON source.
  // Each NOTAM becomes its own circle Polygon feature; properties carry
  // enough to reconstruct a RegionalNotamFeature on click without a re-fetch.
  // Matched-to-a-charted-polygon NOTAMs are excluded here -- they're shown
  // via the highlighted polygon + AirspacePopup instead, not a redundant
  // second circle roughly on top of the same real-world area.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('notam-circles') as import('maplibre-gl').GeoJSONSource | undefined
    if (!src) return

    const features = regionalNotams
      .filter((n) => !n.polygon) // real polygon geometry (below) takes priority over the synthesized circle
      .filter((n) => n.lat !== null && n.lon !== null && n.radiusNm !== null && n.radiusNm > 0)
      .filter((n) => !matchedNotamIds.has(n.nmsId)) // nmsId, not display id -- see useNotamAirspaceMatch.ts's own comment
      .map((n) => {
        const circle = makeCirclePolygon(n.lat!, n.lon!, n.radiusNm!)
        circle.properties = {
          notamId:        n.id,
          qCode:          n.qCode ?? null,
          nmsId:          n.nmsId,
          text:           n.text,
          effective:      n.effective,
          expires:        n.expires,
          classification: n.classification,
          icaoLocation:   n.icaoLocation,
          radiusNm:       n.radiusNm,
        }
        return circle
      })
    src.setData({ type: 'FeatureCollection', features })
  }, [regionalNotams, matchedNotamIds, mapReady])

  // Feed point-only regional NOTAMs (coordinates but no usable radius) into
  // the clustered 'notam-points' source -- see that source's own setup
  // comment for why these need a separate, Point-geometry source from
  // notam-circles' Polygon geometry.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('notam-points') as import('maplibre-gl').GeoJSONSource | undefined
    if (!src) return

    const features: GeoJSON.Feature[] = regionalNotams
      .filter((n) => !n.polygon)
      .filter((n) => n.lat !== null && n.lon !== null && (n.radiusNm === null || n.radiusNm <= 0))
      .map((n) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [n.lon!, n.lat!] },
        properties: {
          notamId:        n.id,
          qCode:          n.qCode ?? null,
          nmsId:          n.nmsId,
          text:           n.text,
          effective:      n.effective,
          expires:        n.expires,
          classification: n.classification,
          icaoLocation:   n.icaoLocation,
          radiusNm:       null,
        },
      }))
    src.setData({ type: 'FeatureCollection', features })
  }, [regionalNotams, mapReady])

  // Feed real-geometry regional NOTAM polygons into the 'notam-polygons'
  // GeoJSON source -- see that source's setup comment. Not filtered against
  // matchedNotamIds like notam-circles above: a NOTAM with real polygon
  // geometry from NMS-API is never a designator-based match against a
  // charted airspace (useNotamAirspaceMatch.ts only matches circle/point
  // NOTAMs' text against airspace designators), so there's no matched-
  // airspace highlight this would otherwise duplicate.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('notam-polygons') as import('maplibre-gl').GeoJSONSource | undefined
    if (!src) return

    const features: GeoJSON.Feature[] = regionalNotams
      .filter((n) => n.polygon !== null)
      .map((n) => ({
        type: 'Feature',
        geometry: n.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon,
        properties: {
          notamId:        n.id,
          qCode:          n.qCode ?? null,
          nmsId:          n.nmsId,
          text:           n.text,
          effective:      n.effective,
          expires:        n.expires,
          classification: n.classification,
          icaoLocation:   n.icaoLocation,
          radiusNm:       null,
        },
      }))
    src.setData({ type: 'FeatureCollection', features })
  }, [regionalNotams, mapReady])

  // Feed matched (charted, permanent) restricted/danger areas into the
  // 'notam-matched-airspace' highlight source -- visually distinguishes
  // "this charted area has an active NOTAM right now" from the plain
  // airspace-fill-* layers underneath, without altering their own paint.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('notam-matched-airspace') as import('maplibre-gl').GeoJSONSource | undefined
    if (!src) return

    const features: GeoJSON.Feature[] = notamAirspaceMatches.map((m) => ({
      type: 'Feature',
      geometry: m.geometry,
      properties: { name: m.airspaceName },
    }))
    src.setData({ type: 'FeatureCollection', features })
  }, [notamAirspaceMatches, mapReady])

  // Proactive lookahead alerts + silent entry/exit toasts for NOTAM circles --
  // same treatment as se-airspace.geojson polygons (useAirspaceWarnings/
  // useAirspaceNotifications above), fed from the same regionalNotams data
  // already being polled for the map circles (no duplicate fetch).
  const { alerts: notamAlerts, dismiss: dismissNotam } = useNotamWarnings(flyingMode !== 'off' ? gpsPosition : null, regionalNotams)
  const { notifications: notamNotifications } = useNotamNotifications(flyingMode !== 'off' ? gpsPosition : null, regionalNotams)

  // Track which icao24s were already proximate (urgency=3) to avoid repeat beeps
  const proxAlertedRef = useRef(new Set<string>())

  // Feed dead-reckoned traffic positions into the MapLibre GeoJSON source
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('traffic') as import('maplibre-gl').GeoJSONSource | undefined
    if (!src) return

    const ownLat = gpsPosition?.lat ?? null
    const ownLon = gpsPosition?.lng ?? null
    const ownAlt = gpsPosition?.altFt ?? null

    // Compute proximity urgency (0=white,1=green,2=yellow,3=red)
    function getUrgency(lat: number, lon: number, relAlt: number | null): 0 | 1 | 2 | 3 {
      if (ownLat === null || ownLon === null) return 0
      const dLat = (lat - ownLat) * Math.PI / 180
      const dLon = (lon - ownLon) * Math.PI / 180
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(ownLat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2
      const distNm = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 3440.065
      const absRel = relAlt !== null ? Math.abs(relAlt) : 99999
      if (distNm < 1   && absRel < 500)  return 3
      if (distNm < 2   && absRel < 1000) return 2
      if (distNm < 3   && absRel < 3000) return 1
      return 0
    }

    // Apply vertical filter and compute urgency per target
    const proximate = new Set<string>()
    const features = trafficTargets
      .filter(t => {
        if (trafficVertFilter === 0 || ownAlt === null) return true
        if (t.relAltFt === null) return true
        return Math.abs(t.relAltFt) <= trafficVertFilter
      })
      .map(t => {
        const urgency = getUrgency(t.lat, t.lon, t.relAltFt)
        if (urgency === 3) proximate.add(t.icao24)
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [t.lon, t.lat] },
          properties: {
            icao24:    t.icao24,
            callsign:  t.callsign,
            altFt:     t.altFt,
            speedKts:  t.speedKts,
            trackDeg:  t.trackDeg,
            vertFpm:   t.vertFpm,
            onGround:  t.onGround,
            ...(t.relAltFt !== null ? { relAltFt: t.relAltFt } : {}),
            category:  t.category ?? 0,
            urgency,
            iconId:    selectTrafficIcon(t.category, t.speedKts ?? 0),
          },
        }
      })

    src.setData({ type: 'FeatureCollection', features })

    // Audible alert for newly proximate targets
    const alerted = proxAlertedRef.current
    let newProx = false
    for (const id of proximate) {
      if (!alerted.has(id)) { newProx = true; alerted.add(id) }
    }
    // Clean up targets that are no longer proximate so they can alert again if they return
    for (const id of alerted) {
      if (!proximate.has(id)) alerted.delete(id)
    }
    if (newProx) {
      try {
        const ctx = new AudioContext()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.type = 'sine'
        osc.frequency.setValueAtTime(880, ctx.currentTime)
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.12)
        gain.gain.setValueAtTime(0.25, ctx.currentTime)
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25)
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 0.25)
        osc.onended = () => ctx.close()
      } catch { /* audio not available */ }
    }
  }, [trafficTargets, mapReady, gpsPosition, trafficVertFilter])

  // Post-flight track viewer — selected historical log (state declared above near profileCursorNm)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('past-track') as GeoJSONSource | undefined
    if (!selectedLogId) {
      setSelectedLogTrack([])
      src?.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    getDb().then(db => db.flight_logs.findOne(selectedLogId).exec()).then(doc => {
      if (!doc) return
      const track: TrackPoint[] = JSON.parse(doc.trackJson)
      setSelectedLogTrack(track)
      if (track.length < 2) return
      const coords = track.map(p => [p.lng, p.lat] as [number, number])
      src?.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: {},
        }],
      })
      const lngs = track.map(p => p.lng)
      const lats = track.map(p => p.lat)
      map.fitBounds(
        [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: 60, maxZoom: 13, duration: 600 },
      )
    }).catch(console.warn)
  }, [selectedLogId, mapReady])

  // Live wind — fetched at current position + altitude every 5 minutes while flying.
  // On failure retries after 30 s (handles offline start / API blip without waiting 5 min).
  const [liveWind, setLiveWind] = useState<WindAloft | null>(null)
  const windFetchedRef = useRef(false)
  const windRetryRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (flyingMode === 'off') {
      setLiveWind(null)
      windFetchedRef.current = false
      if (windRetryRef.current) { clearTimeout(windRetryRef.current); windRetryRef.current = null }
      return
    }
    const doFetch = () => {
      const pos = gpsPositionRef.current
      if (!pos) return
      fetchWind(pos.lat, pos.lng, pos.altFt > 100 ? pos.altFt : null, '')
        .then(setLiveWind)
        .catch(() => {
          // Retry in 30 s instead of waiting the full 5-minute interval
          windRetryRef.current = setTimeout(doFetch, 30_000)
        })
    }
    doFetch()
    const id = setInterval(doFetch, 5 * 60 * 1000)
    return () => { clearInterval(id); if (windRetryRef.current) clearTimeout(windRetryRef.current) }
  }, [flyingMode])

  // First-position wind trigger: fires when GPS position first becomes available
  // after flying starts, so wind data doesn't wait 5 minutes if pos wasn't ready yet.
  useEffect(() => {
    if (flyingMode === 'off' || !gpsPosition || windFetchedRef.current) return
    if (liveWind) return  // already have wind, no need to re-fetch
    windFetchedRef.current = true
    fetchWind(gpsPosition.lat, gpsPosition.lng, gpsPosition.altFt > 100 ? gpsPosition.altFt : null, '')
      .then(setLiveWind)
      .catch(() => {
        windFetchedRef.current = false  // allow retry on next position update
      })
  }, [flyingMode, gpsPosition, liveWind])

  // Airspace ceiling auto-escalation: if within 500 ft of ceiling, raise by 2 000 ft.
  const [ceilingEscalatedMsg, setCeilingEscalatedMsg] = useState<string | null>(null)
  useEffect(() => {
    if (!ceilingEscalatedMsg) return
    const id = setTimeout(() => setCeilingEscalatedMsg(null), 5000)
    return () => clearTimeout(id)
  }, [ceilingEscalatedMsg])
  useEffect(() => {
    if (flyingMode === 'off' || !gpsPosition) return
    if (gpsPosition.altFt < ceilingFt - 500) return
    // Jump directly to a ceiling that clears the current altitude (+500 ft
    // margin) in ONE step -- see native MapScreen.tsx's identical fix for
    // the full rationale (2026-09-13, "Maximum update depth exceeded"
    // reproduced during a Simulate-mode climb). The old fixed +2000-per-
    // effect-run step could take a dozen+ consecutive escalations to catch
    // up when the persisted ceiling was far below current altitude, all
    // firing in one rapid synchronous chain.
    const newCeiling = Math.min(
      Math.max(ceilingFt + 2000, Math.ceil((gpsPosition.altFt + 500) / 2000) * 2000),
      66000,
    )
    if (newCeiling === ceilingFt) return
    setCeilingFt(newCeiling)
    setCeilingEscalatedMsg(`Ceiling raised to ${newCeiling.toLocaleString()} ft`)
  }, [gpsPosition, ceilingFt, flyingMode])

  // BUG FIX (found live, real production impact): getMapStyle() bakes a
  // versionedTileUrl() call into EVERY tile source (aerodromes, navaids,
  // airspace, hillshade, contours, landuse, basemap, ...) exactly once,
  // synchronously, right here at map construction -- and MapLibre sources
  // generally can't have their URL changed after creation (see the region-
  // swap pattern elsewhere in this file, only exercised for actual region
  // changes). React mounts and this effect runs essentially immediately,
  // while manifest.json is a real network round trip -- this effect was
  // LOSING that race on every single page load, permanently baking in
  // unversioned URLs for the entire session. Confirmed live via a real
  // browser's Network tab: every tile fetch, not just hillshade, came back
  // with NO ?v= query string, and Cloudflare's edge cache showed a HIT with
  // `age` in the hundreds of thousands of seconds (multiple DAYS stale) for
  // an unversioned se-aerodromes.geojson URL that should never have existed
  // -- the entire cache-busting system @open-vfr/shared/tileManifest exists
  // for was silently defeated for every file, this whole time. Fixed with a
  // small gating state flag (manifestReady, set by the separate effect
  // below) added to this effect's own dependency array -- the FIRST run (on
  // mount, manifest not ready yet) bails out via the guard below without
  // creating a map or registering a cleanup function; once manifestReady
  // flips true, this effect re-runs (no stale cleanup to worry about, since
  // the bailed-out first run returned none) and proceeds exactly as before.
  // Bounded by waitForTileManifest()'s own timeout, so a slow/offline first
  // launch still degrades gracefully to unversioned URLs after ~3s rather
  // than blocking the map forever.
  const [manifestReady, setManifestReady] = useState(false)
  useEffect(() => {
    waitForTileManifest(TILES_BASE_URL).then(() => setManifestReady(true))
  }, [])

  // Initialise map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current || !manifestReady) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getMapStyle(),
      // Last known own position (Passive location mode) when there is one;
      // the home-airfield fly-to below still takes over when set.
      center: (() => { const lp = readLastPosition(); return lp ? [lp.lng, lp.lat] as [number, number] : [18.07, 59.33] as [number, number] })(),
      zoom: 8,
      minZoom: 4,
      maxZoom: 17,
      maxPitch: 0,
      pitchWithRotate: false,
      attributionControl: false,
    })
    mapRef.current = map

    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    // Scale, altitude-filter band and data attribution live in MapInfoBar
    // (React overlay, bottom-right) -- MapLibre's own ScaleControl and
    // AttributionControl are deliberately not added. attributionControl:
    // false above; credits are listed in MapInfoBar's (i) dialog instead.

    // Home airfield button — stacks below the navigation control in the top-right corner.
    const homeBtn = document.createElement('button')
    homeBtn.title = 'Fly to home airfield'
    homeBtn.innerHTML = HOME_ICON_SVG
    homeBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;'
    homeBtn.addEventListener('click', () => {
      // homeAirfield is stale in this closure; read from the ref updated below.
      const btn = homeBtn as HTMLButtonElement & { _home?: { lng: number; lat: number } }
      if (btn._home) {
        mapRef.current?.flyTo({ center: [btn._home.lng, btn._home.lat], zoom: 13, speed: 1.4 })
      }
    })
    homeBtnRef.current = homeBtn
    const homeCtrlDiv = document.createElement('div')
    homeCtrlDiv.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    homeCtrlDiv.appendChild(homeBtn)
    map.addControl({ onAdd: () => homeCtrlDiv, onRemove: () => {} }, 'top-right')

    // Locate button (Off / Passive; Follow while flying) -- behaviour lives
    // in locateClickRef so the click always sees current React state.
    const locateBtn = document.createElement('button')
    locateBtn.innerHTML = LOCATE_ICON_SVG
    locateBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;'
    locateBtn.addEventListener('click', () => locateClickRef.current())
    locateBtnRef.current = locateBtn
    const locateCtrlDiv = document.createElement('div')
    locateCtrlDiv.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    locateCtrlDiv.appendChild(locateBtn)
    map.addControl({ onAdd: () => locateCtrlDiv, onRemove: () => {} }, 'top-right')

    // Map ruler toggle — stacks below the route planning button.
    const rulerBtn = document.createElement('button')
    rulerBtn.title = 'Map Ruler — measure distance and bearing'
    rulerBtn.innerHTML = RULER_ICON_SVG
    rulerBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;'
    rulerBtn.addEventListener('click', () => {
      setRulerMode((m) => {
        if (m) setRulerPoints([])   // clear points when turning off
        return !m
      })
    })
    rulerBtnRef.current = rulerBtn
    const rulerCtrlDiv = document.createElement('div')
    rulerCtrlDiv.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    rulerCtrlDiv.appendChild(rulerBtn)
    map.addControl({ onAdd: () => rulerCtrlDiv, onRemove: () => {} }, 'top-right')

    // Go Flying toggle — stacks below the ruler button.
    const flyingBtn = document.createElement('button')
    flyingBtn.title = 'Go Flying — GPS or Simulation'
    flyingBtn.innerHTML = FLYING_ICON_SVG
    flyingBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;'
    flyingBtn.addEventListener('click', () => {
      if (flyingModeRef.current !== 'off') {
        stopFlyingRef.current()
        setShowModePicker(false)
      } else {
        setShowModePicker((m) => !m)
      }
    })
    flyingBtnRef.current = flyingBtn
    const flyingCtrlDiv = document.createElement('div')
    flyingCtrlDiv.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    flyingCtrlDiv.appendChild(flyingBtn)
    map.addControl({ onAdd: () => flyingCtrlDiv, onRemove: () => {} }, 'top-right')

    // Find a Destination button — stacks below the flying button.
    const findDestBtn = document.createElement('button')
    findDestBtn.title = 'Find a Destination'
    findDestBtn.innerHTML = FIND_DEST_ICON_SVG
    findDestBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;'
    findDestBtn.addEventListener('click', () => setShowFindDest(m => !m))
    findDestBtnRef.current = findDestBtn
    const findDestCtrlDiv = document.createElement('div')
    findDestCtrlDiv.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    findDestCtrlDiv.appendChild(findDestBtn)
    map.addControl({ onAdd: () => findDestCtrlDiv, onRemove: () => {} }, 'top-right')

    // Airfield Brief button — stacks below Find a Destination.
    const vicinityBriefBtn = document.createElement('button')
    vicinityBriefBtn.title = 'Airfield Brief'
    vicinityBriefBtn.innerHTML = VICINITY_BRIEF_ICON_SVG
    vicinityBriefBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;'
    vicinityBriefBtn.addEventListener('click', () => setShowVicinityBrief(m => !m))
    const vicinityBriefCtrlDiv = document.createElement('div')
    vicinityBriefCtrlDiv.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    vicinityBriefCtrlDiv.appendChild(vicinityBriefBtn)
    map.addControl({ onAdd: () => vicinityBriefCtrlDiv, onRemove: () => {} }, 'top-right')

    // Register canvas-drawn icons on demand — fires for each missing image ID
    // before the layer renders. This handles the init race where symbol layers
    // in the initial style try to resolve images before styledata fires.
    const registerAllImages = () => {
      registerAerodromeImages(map)
      registerNavaidImages(map)
      registerObstacleImages(map)
      registerLandmarkImages(map)
      registerAllWindBarbIcons(map)
      registerTrafficIcons(map).catch(console.warn)  // async fire-and-forget
      // Register the SVG aircraft icon — category-specific if a profile is selected,
      // otherwise the default cessna icon.
      const profile = selectedAircraftProfileRef.current
      const url = (profile ? aircraftIconUrl(profile.category) : null) ?? '/aircraft_icons/cessna.svg'
      registerAircraftImageFromSvg(map, url).catch(console.warn)
    }
    const handleStyleImageMissing = (ev: { id: string }) => {
      registerAllImages()
      registerWindBarbIcon(map, ev.id)
    }
    map.on('styleimagemissing', handleStyleImageMissing)

    // Suppress the PMTiles "Wrong magic number" transient error that fires on
    // first startup when the pmtiles library reads the archive header before the
    // Vite dev server's response is fully available. The library retries and the
    // map loads successfully — without this handler, MapLibre re-throws the error
    // as an uncaught promise rejection attributed to the map-creation line.
    map.on('error', (ev) => {
      if (ev.error?.message?.includes('Wrong magic number')) return
      console.error('[map]', ev.error ?? ev)
    })

    // 'styledata' fires when the style object is fully parsed (layers exist).
    // NOTE: initial altitude ceiling + layer visibility are deliberately NOT
    // applied here anymore -- they used to call applyAltitudeCeiling(DEFAULT_CEILING_FT)
    // and LAYER_GROUPS.forEach(defaultOn) unconditionally, racing the dedicated
    // sync effects below (ceilingFt effect, visibility effect) that apply the
    // real persisted RxDB value. Both effects already self-handle the
    // not-yet-loaded case (`map.isStyleLoaded() ? apply() : map.once('styledata', apply)`),
    // so they're the single source of truth. Confirmed via live repro: whichever
    // handler's 'styledata' listener happened to fire LAST won, so a toggle whose
    // persisted value differed from its `defaultOn` (e.g. hillshade turned ON and
    // saved) would render at the WRONG visibility after a fresh page load --
    // reading 'off' on the map despite the panel correctly showing ON -- until the
    // user manually re-toggled it (which runs setVisibility() and forces a fresh,
    // unambiguous apply()). Removing this block leaves exactly one writer per
    // setting, eliminating the race outright rather than trying to win it.
    map.once('styledata', () => {
      // Also register here so images are guaranteed present before any render.
      registerAllImages()

      // ── Route planning sources + layers (rendered above all aviation layers) ──
      map.addSource('route-line', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addSource('route-points', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'route-line-layer',
        type: 'line',
        source: 'route-line',
        paint: { 'line-color': '#e040fb', 'line-width': 2.5, 'line-dasharray': [4, 2] },
      })
      map.addLayer({
        id: 'route-waypoints-circle',
        type: 'circle',
        source: 'route-points',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#e040fb',
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: 'route-waypoints-label',
        type: 'symbol',
        source: 'route-points',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Medium'],
          'text-size': 11,
          'text-anchor': 'bottom-left',
          'text-offset': [0.5, -0.3],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#e040fb',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      })

      // ── Alternate destination line ────────────────────────────────────────
      map.addSource('alternate-line', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addSource('alternate-point', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'alternate-line-layer',
        type: 'line',
        source: 'alternate-line',
        paint: { 'line-color': '#fb923c', 'line-width': 2, 'line-dasharray': [3, 4] },
      })
      map.addLayer({
        id: 'alternate-point-layer',
        type: 'circle',
        source: 'alternate-point',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#fb923c',
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: 'alternate-label-layer',
        type: 'symbol',
        source: 'alternate-point',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Medium'],
          'text-size': 11,
          'text-anchor': 'bottom-left',
          'text-offset': [0.5, -0.3],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#fdba74',
          'text-halo-color': '#000000',
          'text-halo-width': 1.5,
        },
      })

      // All route/alternate sources are now registered — safe to sync route data.

      // ── Rubber-band drag-insert sources + layers ──────────────────────────
      // route-midpoints: grab handles at the midpoint of each planned leg.
      map.addSource('route-midpoints', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      // route-drag-preview: live two-segment preview while a drag is in progress.
      map.addSource('route-drag-preview', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      // While dragging, the route as it will be after the drop is drawn in a
      // distinct colour and the original route stays in place, faded.
      map.addLayer({
        id: 'route-drag-preview-layer',
        type: 'line',
        source: 'route-drag-preview',
        paint: { 'line-color': '#ff9800', 'line-width': 3, 'line-dasharray': [4, 2] },
      })
      const fadeRoute = (on: boolean) => {
        if (map.getLayer('route-line-layer')) map.setPaintProperty('route-line-layer', 'line-opacity', on ? 0.35 : 1)
      }
      map.addLayer({
        id: 'route-midpoints-layer',
        type: 'circle',
        source: 'route-midpoints',
        paint: {
          'circle-radius': 5,
          'circle-color': 'rgba(255,255,255,0.15)',
          'circle-stroke-color': '#e040fb',
          'circle-stroke-width': 1.5,
          'circle-stroke-opacity': 0.65,
        },
      })

      // ── Leg labels (heading + IAS) — shown when not in planning mode ─────
      map.addSource('route-leg-labels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'route-leg-labels-layer',
        type: 'symbol',
        source: 'route-leg-labels',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Medium'],
          'text-size': 11,
          'text-rotate': ['get', 'bearing'],
          'text-rotation-alignment': 'map',
          'text-pitch-alignment': 'map',
          'text-anchor': 'center',
          'text-offset': [0, -1.1],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#8b14b0',
          'text-halo-width': 2.5,
        },
      })

      // ── Past-track overlay ───────────────────────────────────────────────
      map.addSource('past-track', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'past-track-layer',
        type: 'line',
        source: 'past-track',
        paint: { 'line-color': '#a78bfa', 'line-width': 2.5, 'line-opacity': 0.9 },
      })

      // Panning: 'grabbing' regardless of the tool cursor, restored on release.
      map.on('dragstart', () => { map.getCanvas().style.cursor = 'grabbing' })
      map.on('dragend', () => { map.getCanvas().style.cursor = baseCursor() })

      // ── Drag-insert interaction ────────────────────────────────────────────
      map.on('mouseenter', 'route-midpoints-layer', () => {
        map.getCanvas().style.cursor = 'grab'
      })
      map.on('mouseleave', 'route-midpoints-layer', () => {
        if (!dragInsertRef.current && !dragMoveRef.current) {
          map.getCanvas().style.cursor = baseCursor()
        }
      })

      // ── Route-line hover → sync VirtualRadar crosshair cursor ─────────────
      map.on('mousemove', 'route-line-layer', (e) => {
        if (routeWaypointsRef.current.length < 2) return
        const distNm = distanceAlongRouteNm(routeWaypointsRef.current, e.lngLat)
        setProfileCursorNmRef.current(distNm)
      })
      map.on('mouseleave', 'route-line-layer', () => {
        setProfileCursorNmRef.current(null)
      })

      // ── Drag-move existing waypoints ─────────────────────────────────────
      map.on('mouseenter', 'route-waypoints-circle', () => {
        if ((!planningModeRef.current && !routeAdjustModeRef.current) || dragInsertRef.current || dragMoveRef.current) return
        map.getCanvas().style.cursor = 'grab'
      })
      map.on('mouseleave', 'route-waypoints-circle', () => {
        if (!dragInsertRef.current && !dragMoveRef.current) {
          map.getCanvas().style.cursor = baseCursor()
        }
      })
      map.on('mousedown', 'route-waypoints-circle', (e) => {
        if ((!planningModeRef.current && !routeAdjustModeRef.current) || e.originalEvent.button !== 0) return
        e.preventDefault()
        e.originalEvent.stopPropagation()
        suppressNextClickRef.current = true
        const feat = e.features?.[0]
        const seq = feat?.properties?.seq as number
        const wpIndex = seq - 1   // seq is 1-based
        if (wpIndex < 0) return
        dragMoveRef.current = { wpIndex, cur: e.lngLat, moved: false }
        map.getCanvas().style.cursor = 'grabbing'
        map.dragPan.disable()
      })

      map.on('mousedown', 'route-midpoints-layer', (e) => {
        // Only respond to left-button (button=0) in planning or adjust mode.
        if ((!planningModeRef.current && !routeAdjustModeRef.current) || e.originalEvent.button !== 0) return
        e.preventDefault()
        e.originalEvent.stopPropagation()

        const feat = e.features?.[0]
        const legIndex = feat?.properties?.legIndex as number ?? -1
        if (legIndex < 0) return

        dragInsertRef.current = { legIndex, cur: e.lngLat }
        map.getCanvas().style.cursor = 'grabbing'
        // Disable map panning during drag.
        map.dragPan.disable()
      })

      map.on('mousemove', (e) => {
        // Drag-insert: midpoint handle → new waypoint between two legs.
        const dragI = dragInsertRef.current
        if (dragI) {
          dragI.cur = e.lngLat
          const wps = routeWaypointsRef.current
          const { legIndex } = dragI
          if (legIndex >= 0 && legIndex < wps.length - 1) {
            const from = wps[legIndex]
            const to   = wps[legIndex + 1]
            const mid  = [e.lngLat.lng, e.lngLat.lat]
            fadeRoute(true)
            ;(map.getSource('route-drag-preview') as GeoJSONSource | undefined)?.setData({
              type: 'FeatureCollection',
              features: [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [
                [[from.lng, from.lat], mid],
                [mid, [to.lng, to.lat]],
              ] }, properties: {} }],
            })
          }
          return
        }

        // Drag-move: existing waypoint → new position.
        const dragM = dragMoveRef.current
        if (dragM) {
          dragM.cur = e.lngLat
          dragM.moved = true
          const wps = routeWaypointsRef.current
          const { wpIndex } = dragM
          const cur: [number, number] = [e.lngLat.lng, e.lngLat.lat]
          const segs: [number, number][][] = []
          if (wpIndex > 0)              segs.push([[wps[wpIndex - 1].lng, wps[wpIndex - 1].lat], cur])
          if (wpIndex < wps.length - 1) segs.push([cur, [wps[wpIndex + 1].lng, wps[wpIndex + 1].lat]])
          fadeRoute(true)
          ;(map.getSource('route-drag-preview') as GeoJSONSource | undefined)?.setData({
            type: 'FeatureCollection',
            features: segs.length > 0 ? [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: segs }, properties: {} }] : [],
          })
          return
        }

        // Aircraft drag-to-reposition (sim mode): live preview follows cursor.
        if (aircraftDragRef.current) {
          ;(map.getSource('aircraft-position') as GeoJSONSource | undefined)?.setData({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] }, properties: { trackDeg: gpsPositionRef.current?.trackDeg ?? 0 } }],
          })
        }
      })

      // Shared snap-query helper used by both commitDrag variants.
      type DragEvent = { lngLat: maplibregl.LngLat; point: maplibregl.Point }
      const snapQuery = (e: DragEvent) => {
        const SNAP_PX = 20
        const box: [maplibregl.PointLike, maplibregl.PointLike] = [
          [e.point.x - SNAP_PX, e.point.y - SNAP_PX],
          [e.point.x + SNAP_PX, e.point.y + SNAP_PX],
        ]
        return map.queryRenderedFeatures(box, { layers: SNAP_LAYERS })
      }

      const buildCandidates = (hits: maplibregl.MapGeoJSONFeature[]): SnapCandidate[] => {
        const seen = new Set<string>()
        const out: SnapCandidate[] = []
        for (const feat of hits) {
          const geom = feat.geometry as { type: 'Point'; coordinates: [number, number] }
          const name = extractSnapName(feat)
          const key  = `${name}|${geom.coordinates[0].toFixed(4)}|${geom.coordinates[1].toFixed(4)}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ kind: extractSnapKind(feat), displayName: extractSnapDisplayName(feat), waypoint: { lng: geom.coordinates[0], lat: geom.coordinates[1], name } })
        }
        return out
      }

      const clearPreview = () => {
        fadeRoute(false)
        ;(map.getSource('route-drag-preview') as GeoJSONSource | undefined)?.setData(
          { type: 'FeatureCollection', features: [] },
        )
      }

      const clearLegLongPress = () => {
        if (legLongPressRef.current !== null) {
          clearTimeout(legLongPressRef.current)
          legLongPressRef.current = null
        }
      }

      // Returns the 0-based index of the route leg closest to (lng, lat).
      // Uses simple Euclidean distance in lng/lat space — fine for the short
      // tap-accuracy distances involved here.
      const nearestLegIndex = (lng: number, lat: number, wps: RouteWaypoint[]): number => {
        let best = 0
        let bestDist = Infinity
        for (let i = 0; i < wps.length - 1; i++) {
          const ax = wps[i].lng, ay = wps[i].lat
          const bx = wps[i + 1].lng, by = wps[i + 1].lat
          const dx = bx - ax, dy = by - ay
          const lenSq = dx * dx + dy * dy
          const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((lng - ax) * dx + (lat - ay) * dy) / lenSq))
          const cx = ax + t * dx, cy = ay + t * dy
          const d = (lng - cx) * (lng - cx) + (lat - cy) * (lat - cy)
          if (d < bestDist) { bestDist = d; best = i }
        }
        return best
      }

      const commitDrag = (e: DragEvent) => {
        // ── Commit drag-move (existing waypoint repositioned) ─────────────
        const dragM = dragMoveRef.current
        if (dragM) {
          dragMoveRef.current = null
          map.dragPan.enable()
          clearPreview()
          map.getCanvas().style.cursor = baseCursor()
          if (!dragM.moved) {
            // Stationary tap in adjust mode → show WP context menu
            if (routeAdjustModeRef.current) {
              setWpMenu({ wpIdx: dragM.wpIndex, x: e.point.x, y: e.point.y })
            }
            return
          }

          const { wpIndex } = dragM
          const moveWp = (wp: RouteWaypoint) => {
            setRouteWaypoints((prev) => {
              const next = [...prev]
              next[wpIndex] = wp
              return next
            })
          }
          const hits = snapQuery(e)
          if (hits.length === 0) {
            moveWp({ lng: e.lngLat.lng, lat: e.lngLat.lat })
          } else {
            const candidates = buildCandidates(hits)
            candidates.push({ kind: 'PT', waypoint: { lng: e.lngLat.lng, lat: e.lngLat.lat } })
            setSnapPicker({ candidates, x: e.point.x, y: e.point.y, insertAt: wpIndex, replaceMode: true })
          }
          return
        }

        // ── Commit drag-insert (new waypoint inserted between two legs) ────
        const dragI = dragInsertRef.current
        if (!dragI) return
        dragInsertRef.current = null
        map.dragPan.enable()
        clearPreview()
        map.getCanvas().style.cursor = baseCursor()

        const { legIndex } = dragI
        const insertWp = (wp: RouteWaypoint) => {
          setRouteWaypoints((prev) => [
            ...prev.slice(0, legIndex + 1),
            wp,
            ...prev.slice(legIndex + 1),
          ])
          setLegOverrides((prev) => {
            const next = [...prev]
            const inherited = next[legIndex] ?? {}
            next.splice(legIndex + 1, 0, inherited)
            return next
          })
        }
        const hits = snapQuery(e)
        if (hits.length === 0) {
          insertWp({ lng: e.lngLat.lng, lat: e.lngLat.lat })
        } else {
          const candidates = buildCandidates(hits)
          candidates.push({ kind: 'PT', waypoint: { lng: e.lngLat.lng, lat: e.lngLat.lat } })
          setSnapPicker({ candidates, x: e.point.x, y: e.point.y, insertAt: legIndex + 1 })
          dragInsertRef.current = { legIndex, cur: dragI.cur }
        }
      }

      map.on('mouseup', commitDrag)

      // Aircraft drag commit — separate handler, runs after commitDrag.
      map.on('mouseup', (e) => {
        if (!aircraftDragRef.current) return
        aircraftDragRef.current = false
        map.dragPan.enable()
        map.getCanvas().style.cursor = baseCursor()
        teleportRef.current(e.lngLat.lat, e.lngLat.lng)
      })

      // ── Touch: start drag on waypoint handle ───────────────────────────
      map.on('touchstart', 'route-waypoints-circle', (e) => {
        if (!planningModeRef.current && !routeAdjustModeRef.current) return
        if (e.originalEvent.touches.length !== 1) return  // ignore multi-touch / pinch
        e.preventDefault()
        e.originalEvent.stopPropagation()
        suppressNextClickRef.current = true
        const feat = e.features?.[0]
        const seq = feat?.properties?.seq as number
        const wpIndex = seq - 1
        if (wpIndex < 0) return
        dragMoveRef.current = { wpIndex, cur: e.lngLat, moved: false }
        map.dragPan.disable()
      })

      // ── Touch: start drag on midpoint handle ───────────────────────────
      map.on('touchstart', 'route-midpoints-layer', (e) => {
        if (!planningModeRef.current && !routeAdjustModeRef.current) return
        if (e.originalEvent.touches.length !== 1) return
        e.preventDefault()
        e.originalEvent.stopPropagation()
        const feat = e.features?.[0]
        const legIndex = feat?.properties?.legIndex as number ?? -1
        if (legIndex < 0) return
        dragInsertRef.current = { legIndex, cur: e.lngLat }
        map.dragPan.disable()
      })

      // ── Touch: tap or drag on leg line to insert a new waypoint ────────
      // Makes the full line a touch target, not just the small midpoint circle.
      //   short tap  (<500 ms, no drag) → commitDrag inserts WP at tap point
      //   long press (≥500 ms, no drag) → auto-inserts WP immediately on hold
      //   touch + drag                  → rubber-band drag-insert (same as midpoint)
      map.on('touchstart', 'route-line-layer', (e) => {
        if (!planningModeRef.current && !routeAdjustModeRef.current) return
        if (e.originalEvent.touches.length !== 1) return
        if (dragInsertRef.current || dragMoveRef.current) return  // midpoint / WP drag already active
        const wps = routeWaypointsRef.current
        if (wps.length < 2) return
        e.preventDefault()
        e.originalEvent.stopPropagation()
        suppressNextClickRef.current = true
        const legIndex = nearestLegIndex(e.lngLat.lng, e.lngLat.lat, wps)
        dragInsertRef.current = { legIndex, cur: e.lngLat }
        map.dragPan.disable()
        // Long-press: show a context menu instead of auto-inserting.
        // The menu offers: Insert here / Append to end / Take Shortcut.
        legLongPressRef.current = setTimeout(() => {
          legLongPressRef.current = null
          const di = dragInsertRef.current
          if (!di || di.legIndex !== legIndex) return
          const cur = di.cur
          // Only fire if the finger hasn't drifted more than ~50 m.
          if (Math.abs(cur.lng - e.lngLat.lng) > 0.0005 || Math.abs(cur.lat - e.lngLat.lat) > 0.0005) return
          dragInsertRef.current = null
          map.dragPan.enable()
          clearPreview()
          const pt = map.project(cur)
          setLegMenu({ legIndex, lngLat: cur, x: pt.x, y: pt.y })
        }, 500)
      })

      // ── Touch: move ────────────────────────────────────────────────────
      map.on('touchmove', (e) => {
        if (e.originalEvent.touches.length !== 1) return
        const dragI = dragInsertRef.current
        if (dragI) {
          clearLegLongPress()  // finger moved — cancel long-press auto-insert
          dragI.cur = e.lngLat
          const wps = routeWaypointsRef.current
          const { legIndex } = dragI
          if (legIndex >= 0 && legIndex < wps.length - 1) {
            const from = wps[legIndex]
            const to   = wps[legIndex + 1]
            const mid  = [e.lngLat.lng, e.lngLat.lat]
            fadeRoute(true)
            ;(map.getSource('route-drag-preview') as GeoJSONSource | undefined)?.setData({
              type: 'FeatureCollection',
              features: [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [
                [[from.lng, from.lat], mid],
                [mid, [to.lng, to.lat]],
              ] }, properties: {} }],
            })
          }
          return
        }
        const dragM = dragMoveRef.current
        if (dragM) {
          dragM.cur = e.lngLat
          dragM.moved = true
          const wps = routeWaypointsRef.current
          const { wpIndex } = dragM
          const cur: [number, number] = [e.lngLat.lng, e.lngLat.lat]
          const segs: [number, number][][] = []
          if (wpIndex > 0)              segs.push([[wps[wpIndex - 1].lng, wps[wpIndex - 1].lat], cur])
          if (wpIndex < wps.length - 1) segs.push([cur, [wps[wpIndex + 1].lng, wps[wpIndex + 1].lat]])
          fadeRoute(true)
          ;(map.getSource('route-drag-preview') as GeoJSONSource | undefined)?.setData({
            type: 'FeatureCollection',
            features: segs.length > 0 ? [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: segs }, properties: {} }] : [],
          })
        }
      })

      // ── Touch: commit drag on finger-lift ──────────────────────────────
      // lngLat is unreliable on touchend (finger lifted), so use last stored cur.
      map.on('touchend', () => {
        clearLegLongPress()
        if (!dragInsertRef.current && !dragMoveRef.current) return
        const cur = dragMoveRef.current?.cur ?? dragInsertRef.current?.cur
        if (!cur) return
        const point = map.project(cur)
        commitDrag({ lngLat: cur, point })
      })

      // Cancel drag on Escape key.
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape' && (dragInsertRef.current || dragMoveRef.current || legLongPressRef.current !== null)) {
          ev.preventDefault() // consumed: don't also close the open popup
          clearLegLongPress()
          dragInsertRef.current = null
          dragMoveRef.current   = null
          map.dragPan.enable()
          clearPreview()
          map.getCanvas().style.cursor = baseCursor()
        }
      }
      window.addEventListener('keydown', onKeyDown)

      // ── Ruler measurement sources + layers ────────────────────────────────
      map.addSource('ruler-line', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addSource('ruler-points', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'ruler-line-layer',
        type: 'line',
        source: 'ruler-line',
        paint: { 'line-color': '#facc15', 'line-width': 2, 'line-dasharray': [6, 3] },
      })
      map.addLayer({
        id: 'ruler-points-layer',
        type: 'circle',
        source: 'ruler-points',
        paint: {
          'circle-radius': 6,
          'circle-color': '#facc15',
          'circle-stroke-color': '#1a1a2e',
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: 'ruler-labels-layer',
        type: 'symbol',
        source: 'ruler-points',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Medium'],
          'text-size': 11,
          'text-anchor': 'bottom',
          'text-offset': [0, -0.9],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#facc15',
          'text-halo-color': '#000000',
          'text-halo-width': 1.5,
        },
      })

      // ── User waypoints sources + layers ───────────────────────────────────
      map.addSource('user-waypoints', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'user-waypoints-circle',
        type: 'circle',
        source: 'user-waypoints',
        paint: {
          'circle-radius': 7,
          'circle-color': '#facc15',
          'circle-stroke-color': '#7c3aed',
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: 'user-waypoints-label',
        type: 'symbol',
        source: 'user-waypoints',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Medium'],
          'text-size': 11,
          'text-anchor': 'bottom-left',
          'text-offset': [0.6, -0.4],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#facc15',
          'text-halo-color': '#000000',
          'text-halo-width': 1.5,
        },
      })

      // ── Aircraft trajectory line ──────────────────────────────────────────
      // Line from aircraft to 5-min/5-NM ahead + perpendicular tick marks at
      // 1, 3, and 5 minute / NM intervals. Updated on every GPS tick.
      map.addSource('aircraft-trajectory', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'aircraft-trajectory-line',
        type: 'line',
        source: 'aircraft-trajectory',
        filter: ['==', ['get', 'type'], 'line'],
        paint: {
          'line-color': '#facc15',
          'line-width': 2,
          'line-opacity': 0.75,
        },
      })
      map.addLayer({
        id: 'aircraft-trajectory-ticks',
        type: 'line',
        source: 'aircraft-trajectory',
        filter: ['==', ['get', 'type'], 'tick'],
        paint: {
          'line-color': '#facc15',
          'line-width': 2,
          'line-opacity': 0.75,
        },
      })

      // ── Aircraft position source + symbol layer ───────────────────────────
      // Rendered above all other layers; icon rotates with trackDeg.
      map.addSource('aircraft-position', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'aircraft-symbol',
        type: 'symbol',
        source: 'aircraft-position',
        layout: {
          'icon-image':                'aircraft-icon',
          'icon-rotate':               ['get', 'trackDeg'],
          'icon-rotation-alignment':   'map',
          'icon-allow-overlap':        true,
          'icon-ignore-placement':     true,
          'icon-size':                 0.75,
        },
      })

      // ── Glide Range ring ──────────────────────────────────────────────────
      // Turquoise polygon ring showing maximum safe glide distance from current
      // GPS altitude + aircraft glide ratio. Updated every position tick.
      map.addSource('glide-range', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'glide-range-fill',
        type: 'fill',
        source: 'glide-range',
        paint: {
          'fill-color': '#06b6d4',
          'fill-opacity': 0.06,
        },
      })
      map.addLayer({
        id: 'glide-range-border',
        type: 'line',
        source: 'glide-range',
        paint: {
          'line-color': '#06b6d4',
          'line-width': 1.5,
          'line-dasharray': [4, 3],
          'line-opacity': 0.7,
        },
      })

      // ── Regional NOTAM circles ───────────────────────────────────────
      // Ad-hoc circles built from each FIR-wide NOTAM's own coordinates+
      // radius (see useRegionalNotams.ts) -- covers restricted/danger areas
      // that don't correspond to any charted airspace polygon (e.g.
      // temporary areas established mid-AIRAC-cycle via AIP supplement).
      map.addSource('notam-circles', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'notam-circles-fill',
        type: 'fill',
        source: 'notam-circles',
        paint: {
          'fill-color': '#e64980',
          'fill-opacity': 0.12,
        },
      })
      map.addLayer({
        id: 'notam-circles-border',
        type: 'line',
        source: 'notam-circles',
        paint: {
          'line-color': '#e64980',
          'line-width': 1.5,
          'line-dasharray': [3, 2],
          'line-opacity': 0.8,
        },
      })

      // ── Regional NOTAM polygons (real area geometry) ──────────────────
      // Distinct from notam-circles above: these are NOTAMs where NMS-API
      // itself resolved the NOTAM text's area description into actual
      // multi-vertex Polygon/MultiPolygon geometry (see apps/api/src/
      // notam.ts's extractNotamPolygon()) -- e.g. a cross-border military
      // exercise box defined by a list of lat/lon vertices in the NOTAM
      // text, not a single point+radius. A solid (non-dashed) border
      // distinguishes a real charted shape from notam-circles' approximated
      // circle at a glance.
      map.addSource('notam-polygons', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'notam-polygons-fill',
        type: 'fill',
        source: 'notam-polygons',
        paint: {
          'fill-color': '#e64980',
          'fill-opacity': 0.12,
        },
      })
      map.addLayer({
        id: 'notam-polygons-border',
        type: 'line',
        source: 'notam-polygons',
        paint: {
          'line-color': '#e64980',
          'line-width': 1.5,
          'line-opacity': 0.85,
        },
      })

      // ── Matched restricted/danger area highlight ──────────────────────────
      // Drawn ABOVE the plain ofm airspace-fill-* layers so a charted area
      // with an active NOTAM stands out from the same-class areas without
      // one, without needing to mutate those layers' own paint expressions.
      map.addSource('notam-matched-airspace', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'notam-matched-airspace-fill',
        type: 'fill',
        source: 'notam-matched-airspace',
        paint: {
          'fill-color': '#e64980',
          'fill-opacity': 0.18,
        },
      })
      map.addLayer({
        id: 'notam-matched-airspace-border',
        type: 'line',
        source: 'notam-matched-airspace',
        paint: {
          'line-color': '#e64980',
          'line-width': 2.5,
          'line-opacity': 0.9,
        },
      })

      // ── Point-only NOTAM markers (clustered) ─────────────────────
      // Regional NOTAMs with coordinates but NO radius (obstacle lights,
      // single-point navaid faults, etc.) have nothing meaningful to draw as
      // a circle -- they were previously only visible in the RegionalNotamsPanel
      // list, invisible on the map entirely. Rendered as clustered points here
      // (MapLibre's built-in cluster support, only applies to Point geometry --
      // this is why these are handled as a separate source from notam-circles,
      // which is all Polygon geometry and can't use the same mechanism).
      // Small numbered pins that collapse into a cluster count at low zoom
      // keeps a dense NOTAM area readable instead of a wall of overlapping pins.
      map.addSource('notam-points', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 50,
      })
      map.addLayer({
        id: 'notam-points-cluster',
        type: 'circle',
        source: 'notam-points',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#e64980',
          'circle-opacity': 0.85,
          'circle-radius': ['step', ['get', 'point_count'], 12, 10, 16, 25, 20],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
        },
      })
      map.addLayer({
        id: 'notam-points-cluster-count',
        type: 'symbol',
        source: 'notam-points',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-size': 11,
          'text-font': ['Noto Sans Medium'],
        },
        paint: { 'text-color': '#ffffff' },
      })
      map.addLayer({
        id: 'notam-points-unclustered',
        type: 'circle',
        source: 'notam-points',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': '#e64980',
          'circle-opacity': 0.9,
          'circle-radius': 7,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
        },
      })
      map.addLayer({
        id: 'notam-points-label',
        type: 'symbol',
        source: 'notam-points',
        filter: ['!', ['has', 'point_count']],
        layout: { 'text-field': 'N', 'text-size': 9, 'text-font': ['Noto Sans Medium'] },
        paint: { 'text-color': '#ffffff' },
      })

      // ── Profile cursor — crosshair marker driven by VirtualRadar hover ────
      // A single Point feature updated whenever the user hovers the profile chart.
      map.addSource('profile-cursor', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'profile-cursor-circle',
        type: 'circle',
        source: 'profile-cursor',
        paint: {
          'circle-radius': 8,
          'circle-color': 'rgba(250,204,21,0.25)',
          'circle-stroke-color': '#facc15',
          'circle-stroke-width': 2,
        },
      })

      // ── Terrain colour-relief (DEM elevation bands) ──────────────────────────
      // Reuses the self-hosted 'osm-hillshade' raster-dem source (Terrarium
      // encoding, Copernicus GLO-30 DEM, static PMTiles from R2 -- see
      // getHillshadeSource() in map-style.ts) already declared in the base
      // style, instead of the previous live AWS/Mapzen Terrarium bucket. Same
      // encoding, no expression changes needed -- removes a runtime external
      // dependency and lets this layer keep working offline once
      // se-hillshade.pmtiles is cached. Requires MapLibre ≥ 5.6 (color-relief).
      // Inserted before the first airspace fill layer so it renders below aviation data.
      //
      // NOTE: 'osm-hillshade' is swapped on region change (removeSource/
      // addSource -- PMTiles url-based sources have no setTiles()) -- the
      // region-swap effect below finds and reinserts every layer that
      // references this source generically, not just the 'hillshade' layer,
      // so 'terrain-color' survives a region change too.
      map.addLayer({
        id: 'terrain-color',
        type: 'color-relief',
        source: 'osm-hillshade',
        layout: { visibility: 'none' },  // toggled on/off via setLayoutProperty
        paint: {
          'color-relief-color': buildTerrainColorExpr(2000),
        },
      } as maplibregl.LayerSpecification, 'landuse-fill')

      // ── Extended runway centrelines ───────────────────────────────────────
      // Two-layer setup: faint lines for all nearby ends, bright line for the
      // one whose inbound bearing best matches the aircraft heading.
      map.addSource('extended-centrelines', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      // Faint dashed lines for all centrelines around the destination
      map.addLayer({
        id: 'extended-centrelines-faint',
        type: 'line',
        source: 'extended-centrelines',
        filter: ['!=', ['get', 'highlight'], true],
        paint: {
          'line-color': '#ffffff',
          'line-width': 1,
          'line-opacity': 0.4,
          'line-dasharray': [6, 5],
        },
      })
      // Bright solid line for the best-matching runway end
      map.addLayer({
        id: 'extended-centrelines-highlight',
        type: 'line',
        source: 'extended-centrelines',
        filter: ['==', ['get', 'highlight'], true],
        paint: {
          'line-color': '#38bdf8',
          'line-width': 2,
          'line-opacity': 0.9,
          'line-dasharray': [8, 4],
        },
      })

      // ── Aircraft drag-to-reposition (sim mode) ────────────────────────────
      map.on('mouseenter', 'aircraft-symbol', () => {
        if (flyingModeRef.current === 'sim') map.getCanvas().style.cursor = 'grab'
      })
      map.on('mouseleave', 'aircraft-symbol', () => {
        if (!aircraftDragRef.current) map.getCanvas().style.cursor = baseCursor()
      })
      map.on('mousedown', 'aircraft-symbol', (e) => {
        if (flyingModeRef.current !== 'sim') return
        e.preventDefault()
        e.originalEvent.stopPropagation()
        suppressNextClickRef.current = true
        aircraftDragRef.current = true
        map.getCanvas().style.cursor = 'grabbing'
        map.dragPan.disable()
      })

      setMapReady(true)
      return () => { clearLegLongPress(); window.removeEventListener('keydown', onKeyDown) }
    })

    // ── Click → popup ─────────────────────────────────────────────────────
    // Show pointer cursor over all clickable layers (point features +
    // airspace) — unconditionally, including while a tool is active — so an
    // actionable feature always has a hover affordance. Leaving restores the
    // idle cursor for the active tool (baseCursor: crosshair for measure /
    // add-waypoint tools, else the map's own grab hand).
    const onEnter = () => { map.getCanvas().style.cursor = 'pointer' }
    const onLeave = () => { map.getCanvas().style.cursor = baseCursor() }
    ;[...POINT_LAYERS, ...AIRSPACE_FILL_LAYERS, 'user-waypoints-circle', 'traffic-symbols', 'notam-circles-fill', 'notam-polygons-fill', 'notam-points-cluster', 'notam-points-unclustered'].forEach((id) => {
      map.on('mouseenter', id, onEnter)
      map.on('mouseleave', id, onLeave)
    })

    map.on('click', async (e) => {
      // Suppress click immediately following a waypoint drag-move mousedown.
      if (suppressNextClickRef.current) { suppressNextClickRef.current = false; return }

      // ── 0. Sim mode click-to-navigate ─────────────────────────────────────
      // In sim mode, any click that doesn't hit a point feature sets the
      // navigation target. Airspace polygon fills are intentionally excluded —
      // nearly the whole map is covered by airspace and they should not block this.
      if (flyingModeRef.current === 'sim' &&
          !rulerModeRef.current &&
          !planningModeRef.current &&
          !placingUserWpRef.current) {
        const hits = map.queryRenderedFeatures(e.point, { layers: [...POINT_LAYERS, 'user-waypoints-circle'] })
        if (hits.length === 0) {
          setSimTargetRef.current(e.lngLat.lat, e.lngLat.lng)
          return
        }
      }

      // ── 0a. Ruler mode — set measurement point A or B ────────────────────
      if (rulerModeRef.current) {
        setRulerPoints(prev => {
          const pt: RouteWaypoint = { lng: e.lngLat.lng, lat: e.lngLat.lat }
          if (prev.length < 2) return [...prev, pt]
          // Replace A with old B, set new B
          return [prev[1], pt]
        })
        return
      }

      // ── 0b. Placing user waypoint mode ────────────────────────────────────
      if (placingUserWpRef.current) {
        setPlacingUserWp(false)
        setPendingUserWpCoords({ lng: e.lngLat.lng, lat: e.lngLat.lat })
        return
      }

      // ── 0c. Planning mode — add waypoint (snapped to nearby feature or raw) ──
      if (planningModeRef.current) {
        setActivePopup(null)
        const SNAP_PX = 20
        const snapBox: [maplibregl.PointLike, maplibregl.PointLike] = [
          [e.point.x - SNAP_PX, e.point.y - SNAP_PX],
          [e.point.x + SNAP_PX, e.point.y + SNAP_PX],
        ]
        const hits = map.queryRenderedFeatures(snapBox, { layers: SNAP_LAYERS })

        if (hits.length === 0) {
          // No nearby feature at all — nothing to choose between.
          setRouteWaypoints((prev) => [...prev, { lng: e.lngLat.lng, lat: e.lngLat.lat }])
        } else {
          // One or more nearby features — never auto-snap. Always let the
          // user choose between the POI(s) found and the exact clicked position.
          const seen = new Set<string>()
          const candidates: SnapCandidate[] = []
          for (const feat of hits) {
            const geom = feat.geometry as { type: 'Point'; coordinates: [number, number] }
            const name = extractSnapName(feat)
            const kind = extractSnapKind(feat)
            const key = `${kind}:${name}:${geom.coordinates[1].toFixed(5)}:${geom.coordinates[0].toFixed(5)}`
            if (!seen.has(key)) {
              seen.add(key)
              candidates.push({ kind, displayName: extractSnapDisplayName(feat), waypoint: { lng: geom.coordinates[0], lat: geom.coordinates[1], name } })
            }
          }
          candidates.push({ kind: 'PT', waypoint: { lng: e.lngLat.lng, lat: e.lngLat.lat } })
          setSnapPicker({ candidates, x: e.point.x, y: e.point.y })
        }
        return
      }

      // ── 0d. Traffic symbol click — show aircraft details ────────────────
      {
        const pad = 12
        const trafficHits = map.queryRenderedFeatures(
          [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]],
          { layers: ['traffic-symbols'] },
        )
        if (trafficHits.length > 0) {
          const p = trafficHits[0].properties as Record<string, unknown>
          const icao24 = String(p.icao24 ?? '')
          const target = trafficTargetsRef.current.find(t => t.icao24 === icao24)
          if (target) {
            setActivePopup({
              kind: 'point',
              feature: {
                kind:     'traffic',
                icao24:   target.icao24,
                callsign: target.callsign,
                altFt:    target.altFt,
                speedKts: target.speedKts,
                trackDeg: target.trackDeg,
                vertFpm:  target.vertFpm,
                relAltFt: target.relAltFt,
                category: target.category,
                onGround: target.onGround,
              },
              x: e.point.x,
              y: e.point.y,
            })
            return
          }
        }
      }

      // ── 0e. (formerly) Regional NOTAM circle/polygon click — REMOVED as an
      // exclusive, click-blocking layer. Large ad-hoc NOTAM areas used to
      // intercept every click within their (often huge, cross-border-scale)
      // extent, making anything charted underneath them unreachable. Ad-hoc
      // NOTAM circles/polygons are now queried alongside charted airspace at
      // step 2 below and merged into the SAME popup as sibling entries
      // (mirroring a reference NOTAM app's own "click selects everything
      // here, each shown as its own list card" pattern) instead of being an
      // independently click-priority layer that shadows everything else.


      // ── 0f. Point-only NOTAM marker click ── cluster expands zoom, individual
      // point shows the same NOTAM popup as circles (radiusNm always null here).
      {
        const pad = 10
        const box: [maplibregl.PointLike, maplibregl.PointLike] = [
          [e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad],
        ]
        const clusterHits = map.queryRenderedFeatures(box, { layers: ['notam-points-cluster'] })
        if (clusterHits.length > 0) {
          const clusterId = clusterHits[0].properties?.cluster_id as number
          const src = map.getSource('notam-points') as import('maplibre-gl').GeoJSONSource
          const zoom = await src.getClusterExpansionZoom(clusterId)
          const coords = (clusterHits[0].geometry as GeoJSON.Point).coordinates as [number, number]
          map.easeTo({ center: coords, zoom })
          return
        }
        // Same rich airspace-style popup as a circle/polygon click (step 2
        // below) -- point-only markers just never resolve a `coords` ring
        // (no area extent to draw), so PolygonThumb falls back to its
        // plain-square placeholder. Kept as its own priority-checked step
        // (not folded into step 2's queryRenderedFeatures list) only
        // because of the padded hit box below vs step 2's exact-point query
        // -- these markers are small enough that padding is needed to hit
        // them reliably, unlike circles/polygons.
        const pointHits = map.queryRenderedFeatures(box, { layers: ['notam-points-unclustered'] })
        if (pointHits.length > 0) {
          const p = pointHits[0].properties as Record<string, unknown>
          const nmsId = String(p.nmsId ?? '')
          setActivePopup({
            kind: 'airspace',
            features: [],
            regionalNotams: [{
              notams: [{
                id:             String(p.notamId ?? ''),
                nmsId,
                text:           String(p.text ?? ''),
                effective:      (p.effective as string | null) ?? null,
                expires:        (p.expires as string | null) ?? null,
                classification: (p.classification as string | null) ?? null,
                icaoLocation:   (p.icaoLocation as string | null) ?? null,
                qCode:          (p.qCode as string | null) ?? null,
                polygon:        null,
                lat:            null,
                lon:            null,
                radiusNm:       null,
              }],
              coords: undefined,
            }],
            focusKey: notamRowKey(nmsId),
            x: e.point.x,
            y: e.point.y,
          })
          return
        }
      }

      // ── 1. Point features (±10 px hit area, higher priority than polygons) ──
      const pad = 10
      const hitBox: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - pad, e.point.y - pad],
        [e.point.x + pad, e.point.y + pad],
      ]
      const pointHits = map.queryRenderedFeatures(hitBox, { layers: POINT_LAYERS })

      if (pointHits.length > 0) {
        const feat    = pointHits[0]
        const p       = feat.properties as Record<string, unknown>
        const layerId = feat.layer.id

        if (AERODROME_LAYERS.includes(layerId)) {
          // Nested arrays are JSON-serialised in MapLibre GeoJSON properties.
          const props = p as unknown as AerodromeFeatureProps
          const geom = feat.geometry as { type: 'Point'; coordinates: [number, number] }
          setActivePopup({
            kind: 'aerodrome',
            props: {
              ...props,
              frequencies: parseJsonProp(props.frequencies, []),
              fuel:         parseJsonProp(props.fuel, []),
              ppr_remarks:  parseJsonProp(props.ppr_remarks, []),
              contacts:     parseJsonProp(props.contacts, []),
              runways:      parseJsonProp(props.runways, []),
              hours_of_operation:   parseJsonProp(props.hours_of_operation, []),
              handling_facilities:  parseJsonProp(props.handling_facilities, []),
              passenger_facilities: parseJsonProp(props.passenger_facilities, []),
            },
            lng: geom.coordinates[0],
            lat: geom.coordinates[1],
            x: e.point.x,
            y: e.point.y,
          })
        } else if (layerId === 'navaids-vor-icon' || layerId === 'navaids-ndb-icon') {
          setActivePopup({
            kind: 'point',
            feature: {
              kind:         'navaid',
              id:           String(p.id          ?? ''),
              name:         String(p.name        ?? ''),
              navaid_type:  String(p.navaid_type ?? ''),
              freq_str:     String(p.freq_str    ?? ''),
              has_dme:      Boolean(p.has_dme),
              elevation_ft: p.elevation_ft != null ? Number(p.elevation_ft) : null,
            },
            x: e.point.x,
            y: e.point.y,
          })
        } else if (layerId === 'waypoints-mrp-icon' || layerId === 'waypoints-rp-icon') {
          setActivePopup({
            kind: 'point',
            feature: {
              kind:      'waypoint',
              id:        String(p.id      ?? ''),
              name:      String(p.name    ?? ''),
              wp_type:   String(p.wp_type ?? ''),
              aerodrome: p.aerodrome ? String(p.aerodrome) : null,
            },
            x: e.point.x,
            y: e.point.y,
          })
        } else if (layerId === 'obstacles-circle') {
          setActivePopup({
            kind: 'point',
            feature: {
              kind:         'obstacle',
              obstacleKind: String(p.kind      ?? ''),
              name:         String(p.name      ?? ''),
              elevation_ft: Number(p.elevation_ft ?? 0),
              height_m:     Number(p.height_m     ?? 0),
            },
            x: e.point.x,
            y: e.point.y,
          })
        } else if (layerId === 'landmarks-icon') {
          setActivePopup({
            kind: 'point',
            feature: {
              kind:         'landmark',
              landmarkKind: String(p.kind     ?? ''),
              name:         String(p.name     ?? ''),
              height_m:     Number(p.height_m ?? 0),
            },
            x: e.point.x,
            y: e.point.y,
          })
        }
        return
      }

      // ── 1b. User waypoints (shown as What's Here panel with single item) ──
      const uwpHits = map.queryRenderedFeatures(hitBox, { layers: ['user-waypoints-circle'] })
      if (uwpHits.length > 0) {
        const uf = uwpHits[0]
        const up = uf.properties as Record<string, unknown>
        const ug = uf.geometry as { type: 'Point'; coordinates: [number, number] }
        setActivePopup({
          kind: 'whatshere',
          items: [{
            kind: 'userWaypoint',
            id:     String(up.id     ?? ''),
            name:   String(up.name   ?? ''),
            folder: String(up.folder ?? ''),
            lng: ug.coordinates[0],
            lat: ug.coordinates[1],
          }],
          airspaceFeatures: [],
          lng: ug.coordinates[0],
          lat: ug.coordinates[1],
          x: e.point.x,
          y: e.point.y,
        })
        return
      }

      // ── 2. Airspace polygons + ad-hoc regional NOTAMs (exact click point,
      // no padding) ──────────────────────────────────────────────────────
      // Independent of the altitude-ceiling filter and per-class layer
      // toggles — those only control what's drawn, not what's queried here.
      const airspaceHits = await queryAirspaceAtPoint(e.lngLat.lng, e.lngLat.lat, versionedTileUrl(TILES_BASE_URL, 'se-airspace.geojson'))

      // Ad-hoc NOTAM circles/polygons geometrically covering the exact click
      // point -- queried alongside airspace (not as an independent click-
      // priority layer, see the removed step 0e above) so a large NOTAM
      // area never blocks clicking whatever's charted underneath it.
      // Individual point-only markers included too (harmless, small hit
      // area); the cluster-expand-zoom interaction (step 0f) already
      // short-circuits before reaching here.
      const notamGeomHits = map.queryRenderedFeatures(e.point, {
        layers: ['notam-circles-fill', 'notam-polygons-fill', 'notam-points-unclustered'],
      })
      const seenNotamHitIds = new Set<string>()
      const regionalNotamHits: RegionalNotamHit[] = []
      for (const hit of notamGeomHits) {
        const p = hit.properties as Record<string, unknown>
        const nmsId = String(p.nmsId ?? '')
        if (!nmsId || seenNotamHitIds.has(nmsId)) continue
        seenNotamHitIds.add(nmsId)

        // Prefer the FULL, un-clipped NotamItem already held in
        // regionalNotamsRef (same data useRegionalNotams() polls, same
        // source handleShowNotamOnMap's notamItemRing() reads from) over
        // the queried map feature's own geometry. MapLibre tiles GeoJSON
        // sources internally (geojson-vt) even for a single feature spanning
        // multiple internal tiles at the current zoom -- queryRenderedFeatures
        // returns that tile-local, boundary-clipped geometry, not the full
        // source feature, so a wide NOTAM circle/polygon rendered this way
        // came back as a partial wedge/arc instead of the whole shape. Only
        // fall back to the queried (possibly clipped) geometry if this NOTAM
        // isn't in the currently-loaded regional list for some reason.
        const fullItem = regionalNotamsRef.current.find((n) => n.nmsId === nmsId)
        const notam: NotamItem = fullItem ?? {
          id:             String(p.notamId ?? ''),
          nmsId,
          text:           String(p.text ?? ''),
          effective:      (p.effective as string | null) ?? null,
          expires:        (p.expires as string | null) ?? null,
          classification: (p.classification as string | null) ?? null,
          icaoLocation:   (p.icaoLocation as string | null) ?? null,
          qCode:          (p.qCode as string | null) ?? null,
          polygon:        null,
          lat:            null,
          lon:            null,
          radiusNm:       (p.radiusNm as number | null) ?? null,
        }
        regionalNotamHits.push({
          notams: [notam],
          coords: fullItem ? notamItemRing(fullItem) : notamGeometryRing(hit.geometry),
        })
      }

      if (airspaceHits.length > 0 || regionalNotamHits.length > 0) {
        // Attach matched active NOTAM(s) to each clicked feature by name --
        // see useNotamAirspaceMatch.ts. Uses the ref (not the hook value
        // directly) since this click handler closure is registered once.
        const withNotams = (airspaceHits as AirspaceFeature[]).map((f) => {
          const match = matchedAirspaceRef.current.find((m) => m.airspaceName === f.name)
          return match ? { ...f, notams: match.notams } : f
        })
        setActivePopup({
          kind: 'airspace',
          features: withNotams,
          regionalNotams: regionalNotamHits,
          focusKey: pickClickedAirspaceRow(map, e.point, withNotams, regionalNotamHits),
          x: e.point.x,
          y: e.point.y,
        })
        return
      }

      // ── 3. Empty click — leave popup open; only × button closes it ────────
    })

    // ── Right-click → "What's Here?" (or remove route waypoint) ──────────
    map.on('contextmenu', async (e) => {
      const SNAP_PX = 14
      const hitBox: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - SNAP_PX, e.point.y - SNAP_PX],
        [e.point.x + SNAP_PX, e.point.y + SNAP_PX],
      ]

      // maplibre-gl ≥ 6.11 also fires `contextmenu` on a touch long-press,
      // as a synthesized (untrusted) MouseEvent — a real right-click is
      // always trusted. Touch long-press must respect the in-flight
      // route-edit lock (see AGENTS.md) and must not fight our own touch
      // handlers, which already own long-press on route features while
      // editing (waypoint drag, leg long-press menu).
      const fromTouch = !e.originalEvent.isTrusted
      const editing = planningModeRef.current || routeAdjustModeRef.current
      if (fromTouch && editing) {
        const routeLayers = ['route-waypoints-circle', 'route-midpoints-layer', 'route-line-layer']
          .filter(id => map.getLayer(id))
        if (routeLayers.length > 0 && map.queryRenderedFeatures(hitBox, { layers: routeLayers }).length > 0) {
          e.preventDefault()
          return
        }
      }

      // Route waypoint removal takes priority (never from a touch long-press
      // while route editing is locked — falls through to "What's Here?").
      const wpHits = (fromTouch && !editing)
        ? []
        : map.queryRenderedFeatures(hitBox, { layers: ['route-waypoints-circle'] })
      if (wpHits.length > 0) {
        const seq = (wpHits[0].properties as { seq: number }).seq
        setRouteWaypoints(routeWaypointsRef.current.filter((_, i) => i !== seq - 1))
        e.preventDefault()
        return
      }

      // Build "What's Here?" for all other right-clicks.
      e.preventDefault()
      const pad = 10
      const qBox: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - pad, e.point.y - pad],
        [e.point.x + pad, e.point.y + pad],
      ]

      const allPointLayers = [...POINT_LAYERS, 'user-waypoints-circle']
      const phits = map.queryRenderedFeatures(qBox, { layers: allPointLayers })
      const whItems: WhatsHereItem[] = []
      const seen = new Set<string>()

      for (const feat of phits) {
        const fp = feat.properties as Record<string, unknown>
        const lid = feat.layer.id
        const fg = feat.geometry as { type: 'Point'; coordinates: [number, number] }
        const [fLng, fLat] = fg.coordinates

        if (AERODROME_LAYERS.includes(lid)) {
          const key = `ad:${fp.icao}`
          if (!seen.has(key)) {
            seen.add(key)
            const props = fp as unknown as AerodromeFeatureProps
            whItems.push({
              kind: 'aerodrome',
              props: {
                ...props,
                frequencies: parseJsonProp(props.frequencies, []),
                fuel:         parseJsonProp(props.fuel, []),
                ppr_remarks:  parseJsonProp(props.ppr_remarks, []),
                contacts:     parseJsonProp(props.contacts, []),
                runways:      parseJsonProp(props.runways, []),
                hours_of_operation:   parseJsonProp(props.hours_of_operation, []),
                handling_facilities:  parseJsonProp(props.handling_facilities, []),
                passenger_facilities: parseJsonProp(props.passenger_facilities, []),
              },
              lng: fLng, lat: fLat,
            })
          }
        } else if (lid === 'navaids-vor-icon' || lid === 'navaids-ndb-icon') {
          const key = `nav:${fp.id}`
          if (!seen.has(key)) {
            seen.add(key)
            whItems.push({
              kind: 'navaid',
              feature: {
                kind: 'navaid',
                id:           String(fp.id          ?? ''),
                name:         String(fp.name        ?? ''),
                navaid_type:  String(fp.navaid_type ?? ''),
                freq_str:     String(fp.freq_str    ?? ''),
                has_dme:      Boolean(fp.has_dme),
                elevation_ft: fp.elevation_ft != null ? Number(fp.elevation_ft) : null,
              },
              lng: fLng, lat: fLat,
            })
          }
        } else if (lid === 'waypoints-mrp-icon' || lid === 'waypoints-rp-icon') {
          const key = `wp:${fp.id}`
          if (!seen.has(key)) {
            seen.add(key)
            whItems.push({
              kind: 'waypoint',
              feature: {
                kind:      'waypoint',
                id:        String(fp.id      ?? ''),
                name:      String(fp.name    ?? ''),
                wp_type:   String(fp.wp_type ?? ''),
                aerodrome: fp.aerodrome ? String(fp.aerodrome) : null,
              },
              lng: fLng, lat: fLat,
            })
          }
        } else if (lid === 'obstacles-circle') {
          const key = `obs:${fLng.toFixed(5)},${fLat.toFixed(5)}`
          if (!seen.has(key)) {
            seen.add(key)
            whItems.push({
              kind: 'obstacle',
              feature: {
                kind: 'obstacle',
                obstacleKind: String(fp.kind      ?? ''),
                name:         String(fp.name      ?? ''),
                elevation_ft: Number(fp.elevation_ft ?? 0),
                height_m:     Number(fp.height_m     ?? 0),
              },
            })
          }
        } else if (lid === 'landmarks-icon') {
          const key = `lmk:${fLng.toFixed(5)},${fLat.toFixed(5)}`
          if (!seen.has(key)) {
            seen.add(key)
            whItems.push({
              kind: 'landmark',
              feature: {
                kind: 'landmark',
                landmarkKind: String(fp.kind     ?? ''),
                name:         String(fp.name     ?? ''),
                height_m:     Number(fp.height_m ?? 0),
              },
            })
          }
        } else if (lid === 'user-waypoints-circle') {
          const key = `uwp:${fp.id}`
          if (!seen.has(key)) {
            seen.add(key)
            whItems.push({
              kind: 'userWaypoint',
              id:     String(fp.id     ?? ''),
              name:   String(fp.name   ?? ''),
              folder: String(fp.folder ?? ''),
              lng: fLng, lat: fLat,
            })
          }
        }
      }

      // Airspace at the exact click point — same rationale as the left-click
      // handler above: always complete, regardless of filter/visibility.
      const whAirspace = await queryAirspaceAtPoint(e.lngLat.lng, e.lngLat.lat, versionedTileUrl(TILES_BASE_URL, 'se-airspace.geojson')) as AirspaceFeature[]

      setActivePopup({
        kind: 'whatshere',
        items: whItems,
        airspaceFeatures: whAirspace,
        lng: e.lngLat.lng,
        lat: e.lngLat.lat,
        x: e.point.x,
        y: e.point.y,
      })
    })

    // Stop auto-following when the user manually pans or pitches the map.
    let followReturnTimer = 0
    const armFollowReturn = () => {
      clearTimeout(followReturnTimer)
      followReturnTimer = window.setTimeout(() => {
        // Not while deliberately adjusting the route in flight.
        if (flyingModeRef.current !== 'off' && !routeAdjustModeRef.current) setFollowAircraft(true)
      }, FOLLOW_RETURN_MS)
    }
    const disableFollow = () => {
      if (flyingModeRef.current !== 'off') {
        setFollowAircraft(false)
        armFollowReturn()
      }
    }
    // Suppress the synthetic click that touch/pointer devices fire after a pan drag.
    // Set the flag at dragstart; clear it on dragend after a 0ms timeout so any
    // pending synthetic click event (which fires synchronously before the timeout)
    // gets consumed by the click handler first.
    const onDragStart = () => {
      suppressNextClickRef.current = true
      disableFollow()
    }
    let dragEndTimer = 0
    const onDragEnd = () => {
      clearTimeout(dragEndTimer)
      dragEndTimer = window.setTimeout(() => { suppressNextClickRef.current = false }, 0)
      // Count the idle period from the end of the gesture, not its start.
      if (flyingModeRef.current !== 'off') armFollowReturn()
    }
    // Catches every user-originated map movement — trackpad two-finger pan and
    // scroll-wheel pan/zoom fire as 'movestart' (with originalEvent set) rather
    // than 'dragstart', so relying on dragstart/pitchstart/rotatestart alone let
    // those gestures leave followAircraft=true and the next GPS tick's easeTo
    // snapped the map straight back mid-pan.
    const onMoveStart = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) disableFollow()
    }
    map.on('dragstart', onDragStart)
    map.on('dragend',   onDragEnd)
    map.on('movestart', onMoveStart)
    map.on('pitchstart', disableFollow)
    map.on('rotatestart', disableFollow)

    return () => {
      ;[...POINT_LAYERS, ...AIRSPACE_FILL_LAYERS, 'user-waypoints-circle', 'traffic-symbols', 'notam-circles-fill', 'notam-polygons-fill', 'notam-points-cluster', 'notam-points-unclustered'].forEach((id) => {
        map.off('mouseenter', id, onEnter)
        map.off('mouseleave', id, onLeave)
      })
      map.off('styleimagemissing', handleStyleImageMissing)
      map.off('dragstart', onDragStart)
      map.off('dragend',   onDragEnd)
      map.off('movestart', onMoveStart)
      map.off('pitchstart', disableFollow)
      map.off('rotatestart', disableFollow)
      clearTimeout(dragEndTimer)
      clearTimeout(followReturnTimer)
      map.remove()
      mapRef.current = null
      flyingBtnRef.current  = null
      findDestBtnRef.current = null
    }
  }, [manifestReady])

  // Sync homeAirfield → home button appearance and its _home data ref.
  useEffect(() => {
    const btn = homeBtnRef.current as (HTMLButtonElement & { _home?: { lng: number; lat: number } }) | null
    if (!btn) return
    if (homeAirfield) {
      btn._home = { lng: homeAirfield.lng, lat: homeAirfield.lat }
      btn.title = `Home: ${homeAirfield.icao}`
      btn.innerHTML = HOME_ICON_SVG
      btn.style.opacity = '1'
      btn.style.outline = '2px solid #fbbf24'
      btn.style.outlineOffset = '-2px'
      btn.style.borderRadius = '4px'
    } else {
      btn._home = undefined
      btn.title = 'No home airfield set — tap an aerodrome to set one'
      btn.innerHTML = HOME_ICON_SVG
      btn.style.opacity = '0.45'
      btn.style.outline = ''
      btn.style.outlineOffset = ''
      btn.style.borderRadius = ''
    }
  }, [homeAirfield])

  // On first load: fly to home airfield instead of the hardcoded Stockholm default.
  // Only fires once (ref guard) and only when both homeAirfield and mapReady are set.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || hasInitialCenteredRef.current || !homeAirfield) return
    hasInitialCenteredRef.current = true
    map.flyTo({ center: [homeAirfield.lng, homeAirfield.lat], zoom: 11, duration: 1200 })
  }, [homeAirfield, mapReady])

  // Sync visibility toggles → MapLibre
  // basemapMode is also a dependency: terrain is hidden in satellite mode.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const apply = () => {
      LAYER_GROUPS.forEach((group) => {
        // Every Terrain-section layer (landuse fill, hillshade incl. its
        // water-cover fill, contours) is suppressed in satellite mode --
        // the imagery already shows the ground, and the fills would paint
        // over it. Terrain colour is gated the same way in its own effect.
        const on =
          (visibility[group.id] ?? group.defaultOn) &&
          !(basemapMode === 'satellite' && group.section === 'Terrain')
        group.layerIds.forEach((layerId) => {
          if (map.getLayer(layerId)) {
            map.setLayoutProperty(layerId, 'visibility', on ? 'visible' : 'none')
          }
        })
      })
    }

    // Always apply immediately -- apply() is a safe no-op per layer (guarded by
    // map.getLayer()) if the style hasn't parsed yet. Do NOT gate this on
    // map.isStyleLoaded(): that flag lags briefly right after 'styledata' fires
    // (same lagging-flag gotcha documented for map.getFilter() elsewhere in this
    // file), so an effect run holding the freshly-loaded persisted visibility
    // value could see isStyleLoaded()===false, skip applying, and instead queue
    // a map.once('styledata', apply) listener that never fires again (that
    // event only fires once during init) -- leaving the map stuck showing an
    // earlier run's stale default values forever. Confirmed via live repro:
    // toggling airspace groups off, refreshing, and finding the settings panel
    // correctly showing OFF while the actual MapLibre layers stayed 'visible'.
    // Calling apply() unconditionally on every run fixes it outright; the
    // 'styledata' listener below remains only as a fallback for the genuinely
    // too-early case (style not parsed at all yet, no layers exist).
    //
    // BUG FIX (2nd, related bug, found live -- same symptom, different root
    // cause): mapReady added to this effect's own dependency array below.
    // On initial mount, mapRef.current is still null (map construction is
    // now gated behind waitForTileManifest() -- see the map-init effect's
    // own comment -- so this is measurably later than before, not just
    // instant). Without mapReady as a dependency, THIS effect's initial run
    // hits the `if (!map) return` guard and does nothing -- and since
    // `visibility`/`basemapMode` don't change on their own afterward (a
    // pilot who doesn't touch any toggle never changes either), the effect
    // never runs again once the map actually finishes loading. Every layer
    // group (not just hillshade) would then show correctly "on" in the
    // Settings panel while never actually being visible on the map, until
    // manually toggled off/on once (which DOES change `visibility` state,
    // triggering a fresh, now-successful run). mapReady already exists and
    // flips true from the map's own 'load' handler -- adding it here means
    // this effect gets a guaranteed second chance to apply the real,
    // already-correct persisted state at the moment the map is genuinely
    // ready, with no dependency on any toggle actually changing.
    apply()
    if (!map.isStyleLoaded()) map.once('styledata', apply)
  }, [visibility, basemapMode, mapReady])

  // Switch between vector (Protomaps) and satellite (ESRI) basemap.
  // Uses MapLibre runtime API — no full style reload, all aviation layers preserved.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const apply = () => {
      const isSat = basemapMode === 'satellite'

      // Toggle satellite raster layer at the bottom of the stack
      if (map.getLayer('satellite-raster')) {
        map.setLayoutProperty('satellite-raster', 'visibility', isSat ? 'visible' : 'none')
      }

      // Toggle all Protomaps vector layers
      PROTOMAPS_LAYER_IDS.forEach((id) => {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, 'visibility', isSat ? 'none' : 'visible')
        }
      })

      // OSM landuse-fill comes from Martin (separate source), not Protomaps —
      // must be hidden separately in satellite mode.
      if (map.getLayer('landuse-fill')) {
        map.setLayoutProperty('landuse-fill', 'visibility', isSat ? 'none' : 'visible')
      }


      // Boost text-halo width on aviation labels for readability over imagery
      AVIATION_LABEL_LAYERS.forEach((id) => {
        if (!map.getLayer(id)) return
        map.setPaintProperty(id, 'text-halo-color', '#ffffff')
        map.setPaintProperty(id, 'text-halo-width', isSat ? 2.5 : 1.5)
      })

      // Boost / restore airspace border line-widths for legibility over satellite imagery
      AIRSPACE_BORDER_WIDTHS.forEach(({ id, vector, sat }) => {
        if (!map.getLayer(id)) return
        map.setPaintProperty(id, 'line-width', isSat ? sat : vector)
      })
    }

    if (map.isStyleLoaded()) apply()
    else map.once('styledata', apply)

    // BUG FIX: mapReady added -- same class of bug as the layer-visibility
    // effect above (see its comment for the full explanation). If a pilot
    // previously chose satellite mode (persisted basemapMode) and refreshes,
    // mapRef.current is null on this effect's initial run (map construction
    // gated behind waitForTileManifest()), so it does nothing; basemapMode
    // doesn't change again on its own, so the map stays stuck in vector mode
    // (with the Layers panel showing satellite selected) until manually toggled.
  }, [basemapMode, mapReady])

  // Sync planningMode → ref so the click handler closure always reads current value.
  useEffect(() => {
    planningModeRef.current = planningMode
  }, [planningMode])

  // Sync routeWaypoints → ref so the contextmenu handler closure always reads current value.
  useEffect(() => {
    routeWaypointsRef.current = routeWaypoints
  }, [routeWaypoints])

  // Sync ruler state → refs.
  useEffect(() => {
    rulerModeRef.current = rulerMode
  }, [rulerMode])

  useEffect(() => {
    rulerPointsRef.current = rulerPoints
  }, [rulerPoints])

  // Sync placingUserWp → ref.
  useEffect(() => {
    placingUserWpRef.current = placingUserWp
  }, [placingUserWp])

  // Persist folderVisibility to localStorage.
  useEffect(() => {
    try { localStorage.setItem('ovfr:uwp:folderVis', JSON.stringify(folderVisibility)) } catch { /* quota */ }
  }, [folderVisibility])

  // Route activate/deactivate: display layer visibility only — the toggle
  // itself now lives in the side pane's RoutePlan header (Active/Inactive
  // button), mirroring native's PlanScreen header toggle, instead of a
  // floating map-corner icon button.
  // Independent of planningMode's dashed/midpoint styling — applied after that effect
  // so a hidden route stays hidden even while planning mode is on.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const editMode = planningMode || routeAdjustMode
    ROUTE_DISPLAY_LAYERS.forEach((id) => {
      if (!map.getLayer(id)) return
      if (!routeVisible) { map.setLayoutProperty(id, 'visibility', 'none'); return }
      // Restore each layer's normal edit-vs-view visibility rule.
      if (id === 'route-midpoints-layer') map.setLayoutProperty(id, 'visibility', editMode ? 'visible' : 'none')
      else if (id === 'route-leg-labels-layer') map.setLayoutProperty(id, 'visibility', editMode ? 'none' : 'visible')
      else map.setLayoutProperty(id, 'visibility', 'visible')
    })
  }, [routeVisible, planningMode, routeAdjustMode, mapReady])

  // Planning mode: toggle button highlight + line style; also re-applies the
  // idle cursor for the active tool (see baseCursor).
  useEffect(() => {
    const map = mapRef.current
    if (map) map.getCanvas().style.cursor = baseCursor()
    if (map && mapReady) {
      const editMode = planningMode || routeAdjustMode
      // Dashed while editing, solid when viewing the finished route.
      map.setPaintProperty('route-line-layer', 'line-dasharray', editMode ? [4, 2] : undefined)
      // Midpoint handles and leg labels are mutually exclusive.
      map.setLayoutProperty('route-midpoints-layer', 'visibility', editMode ? 'visible' : 'none')
      map.setLayoutProperty('route-leg-labels-layer', 'visibility', editMode ? 'none' : 'visible')
    }
  }, [planningMode, routeAdjustMode, rulerMode, placingUserWp, mapReady])

  // Ruler mode: yellow button highlight.
  useEffect(() => {
    if (rulerBtnRef.current) {
      rulerBtnRef.current.style.backgroundColor = rulerMode ? 'rgba(250, 204, 21, 0.85)' : ''
      rulerBtnRef.current.style.color = rulerMode ? '#000000' : ''
    }
  }, [rulerMode])

  // Sync route waypoints → MapLibre GeoJSON sources.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const coords = routeWaypoints.map((w) => [w.lng, w.lat])
    ;(map.getSource('route-line') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: coords.length >= 2
        ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }]
        : [],
    })
    ;(map.getSource('route-points') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: routeWaypoints.map((w, i) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [w.lng, w.lat] },
        properties: { seq: i + 1, name: w.name ?? `WP${i + 1}` },
      })),
    })

    // Midpoint handles — one per leg.
    const midFeatures = []
    for (let i = 0; i < routeWaypoints.length - 1; i++) {
      const a = routeWaypoints[i], b = routeWaypoints[i + 1]
      midFeatures.push({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [(a.lng + b.lng) / 2, (a.lat + b.lat) / 2] },
        properties: { legIndex: i },
      })
    }
    ;(map.getSource('route-midpoints') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection', features: midFeatures,
    })
  }, [routeWaypoints, mapReady])

  // Sync leg labels (mag heading + IAS) → MapLibre symbol layer.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const labelFeatures = []
    for (let i = 0; i < routeWaypoints.length - 1; i++) {
      const from = routeWaypoints[i]
      const to   = routeWaypoints[i + 1]
      const midLng = (from.lng + to.lng) / 2
      const midLat = (from.lat + to.lat) / 2
      const magHdg = magneticBearingDeg(from, to)
      const hdgStr = `${Math.round(magHdg).toString().padStart(3, '0')}°`
      const ias = legOverrides[i]?.speedKts ?? selectedAircraftProfile?.cruiseIas
      const label = ias ? `${hdgStr}  ${Math.round(ias)}kt` : hdgStr
      // Rotate text to follow the leg; flip so it never reads upside-down.
      const rawBearing = bearingDeg(from, to)
      const rotation   = (rawBearing > 90 && rawBearing <= 270) ? rawBearing - 180 : rawBearing
      labelFeatures.push({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [midLng, midLat] },
        properties: { label, bearing: rotation },
      })
    }
    ;(map.getSource('route-leg-labels') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection', features: labelFeatures,
    })
  }, [routeWaypoints, legOverrides, selectedAircraftProfile, mapReady])

  // Sync alternate destination → MapLibre GeoJSON sources.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const dest = routeWaypoints.length >= 1 ? routeWaypoints[routeWaypoints.length - 1] : null
    ;(map.getSource('alternate-line') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: alternate && dest
        ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[dest.lng, dest.lat], [alternate.lng, alternate.lat]] }, properties: {} }]
        : [],
    })
    ;(map.getSource('alternate-point') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: alternate
        ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [alternate.lng, alternate.lat] }, properties: { name: `ALT: ${alternate.icao}` } }]
        : [],
    })
  }, [alternate, routeWaypoints, mapReady])

  // Sync altitude slider → MapLibre filters
  // BUG FIX: mapReady added -- same class of bug as the layer-visibility
  // effect further above (see its comment for the full explanation). A
  // persisted non-default ceilingFt otherwise silently fails to apply on
  // refresh (mapRef.current is null on this effect's initial run; ceilingFt
  // doesn't change again on its own until the pilot moves the slider),
  // leaving every altitude-filtered layer showing as if no filter were
  // active until the slider is touched once.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (map.isStyleLoaded()) {
      applyAltitudeCeiling(map, ceilingFt)
    } else {
      map.once('styledata', () => applyAltitudeCeiling(map, ceilingFt))
    }
  }, [ceilingFt, mapReady])

  // Sync region selector → osm-landuse PMTiles source.
  // PMTiles vector sources are url-based, not tiles[]-based, so there's no
  // setTiles() equivalent (unlike the old Martin-backed vector source) --
  // swap the whole source instead. 'landuse-fill' is the only layer that
  // references 'osm-landuse' (map-style.ts); removeSource() throws if any
  // layer still references it, so remove+re-add that layer around the swap,
  // reinserting at its original position (captured via the following layer's
  // id as the addLayer 'before' argument) so it doesn't jump to the top of
  // the draw order.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    if (!map.getSource('osm-landuse')) return
    const styleLayers = map.getStyle()?.layers ?? []
    const idx = styleLayers.findIndex((l) => l.id === 'landuse-fill')
    if (idx === -1) return
    const landuseLayer = styleLayers[idx]
    const beforeId = idx + 1 < styleLayers.length ? styleLayers[idx + 1].id : undefined

    map.removeLayer('landuse-fill')
    map.removeSource('osm-landuse')
    map.addSource('osm-landuse', getLanduseSource(region))
    map.addLayer(landuseLayer, beforeId)
  }, [region])

  // Sync region selector → osm-hillshade PMTiles source. Same removeLayer/
  // removeSource/re-add pattern as osm-landuse above — raster-dem PMTiles
  // sources are also url-based with no setTiles() equivalent.
  //
  // Generic (not hardcoded to the 'hillshade' layer id): 'terrain-color'
  // (added once at init, see the styledata handler above) also reads from
  // this same source — reused instead of its own separate live AWS/Mapzen
  // DEM source. Any current or future layer referencing 'osm-hillshade' is
  // found, captured with its OWN still-existing neighbour as the re-add
  // anchor (safe here since these layers are not adjacent to each other,
  // unlike the osm-contours pair below), then reinserted after the swap.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    if (!map.getSource('osm-hillshade')) return
    const styleLayers = map.getStyle()?.layers ?? []
    const affected = styleLayers
      .map((l, idx) => ({ l, idx }))
      .filter(({ l }) => (l as unknown as { source?: string }).source === 'osm-hillshade')
      .map(({ l, idx }) => ({
        layer: l,
        beforeId: idx + 1 < styleLayers.length ? styleLayers[idx + 1].id : undefined,
      }))
    if (affected.length === 0) return

    affected.forEach(({ layer }) => { if (map.getLayer(layer.id)) map.removeLayer(layer.id) })
    map.removeSource('osm-hillshade')
    map.addSource('osm-hillshade', getHillshadeSource(region))
    affected.forEach(({ layer, beforeId }) => map.addLayer(layer, beforeId))
  }, [region])

  // Sync region selector → osm-contours PMTiles source. Two adjacent layers
  // ('contour-line', 'contour-label') both reference this source — remove
  // both around the swap (removeSource throws if any layer still references
  // it), then reinsert both, in order, before whatever originally followed
  // 'contour-label' (a single shared anchor — addLayer's `before` must
  // already exist, so re-adding each with its own stale neighbour id would
  // fail for the first one re-added).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    if (!map.getSource('osm-contours')) return
    const styleLayers = map.getStyle()?.layers ?? []
    const lineIdx = styleLayers.findIndex((l) => l.id === 'contour-line')
    const labelIdx = styleLayers.findIndex((l) => l.id === 'contour-label')
    if (lineIdx === -1 || labelIdx === -1) return
    const lineLayer = styleLayers[lineIdx]
    const labelLayer = styleLayers[labelIdx]
    const anchorIdx = labelIdx + 1
    const anchorId = anchorIdx < styleLayers.length ? styleLayers[anchorIdx].id : undefined

    map.removeLayer('contour-line')
    map.removeLayer('contour-label')
    map.removeSource('osm-contours')
    map.addSource('osm-contours', getContoursSource(region))
    map.addLayer(lineLayer, anchorId)
    map.addLayer(labelLayer, anchorId)
  }, [region])

  // Sync ruler points → MapLibre ruler sources.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    ;(map.getSource('ruler-line') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: rulerPoints.length >= 2 ? [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: rulerPoints.map(p => [p.lng, p.lat]) },
        properties: {},
      }] : [],
    })
    ;(map.getSource('ruler-points') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: rulerPoints.map((p, i) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { label: i === 0 ? 'A' : 'B' },
      })),
    })
  }, [rulerPoints, mapReady])

  // Sync user waypoints → MapLibre GeoJSON source, filtered by folder visibility.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const visible = userWaypoints.filter(w => folderVisibility[w.folder] !== false)
    ;(map.getSource('user-waypoints') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: visible.map(w => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [w.lng, w.lat] },
        properties: { id: w.id, name: w.name, folder: w.folder },
      })),
    })
  }, [userWaypoints, folderVisibility, mapReady])

  // ── Go Flying effects ────────────────────────────────────────────────────

  // ── Shareable link (?ad=ICAO / ?c=<coord>&z=) — applied once, then the
  // params are stripped via replaceState so a later reload doesn't yank the
  // map back over whatever the user has done since. Never applied while
  // flying (follow mode owns the camera then).
  const mapLinkAppliedRef = useRef(false)
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || mapLinkAppliedRef.current) return
    mapLinkAppliedRef.current = true
    const link = parseMapLink(window.location.search)
    if (!hasMapLink(link) || flyingModeRef.current !== 'off') return
    // A link is an explicit destination: suppress the one-shot "fly to home
    // airfield on first load" effect, which otherwise races this one (home
    // settings often resolve after mapReady) and yanks the camera away.
    hasInitialCenteredRef.current = true
    window.history.replaceState(window.history.state, '', stripMapLinkParams(window.location.href))

    if (link.center) {
      map.jumpTo({ center: [link.center.lng, link.center.lat], zoom: link.zoom ?? 11 })
    }
    if (link.ad) {
      const icao = link.ad
      fetch(versionedTileUrl(TILES_BASE_URL, 'se-aerodromes.geojson'))
        .then(r => (r.ok ? r.json() : null))
        .then((fc: { features?: { geometry: { coordinates: [number, number] }; properties: Record<string, unknown> }[] } | null) => {
          const feat = fc?.features?.find(f => String(f.properties.icao ?? '').toUpperCase() === icao)
          const m = mapRef.current
          if (!feat || !m) return
          const [lng, lat] = feat.geometry.coordinates
          m.jumpTo({ center: [lng, lat], zoom: link.zoom ?? 12 })
          const el = containerRef.current
          const props = feat.properties as unknown as AerodromeFeatureProps
          setActivePopup({
            kind: 'aerodrome',
            // Raw GeoJSON carries real arrays; parseJsonProp also accepts
            // those, matching the map-click path's normalisation.
            props: {
              ...props,
              frequencies: parseJsonProp(props.frequencies, []),
              fuel:         parseJsonProp(props.fuel, []),
              ppr_remarks:  parseJsonProp(props.ppr_remarks, []),
              contacts:     parseJsonProp(props.contacts, []),
              runways:      parseJsonProp(props.runways, []),
              hours_of_operation:   parseJsonProp(props.hours_of_operation, []),
              handling_facilities:  parseJsonProp(props.handling_facilities, []),
              passenger_facilities: parseJsonProp(props.passenger_facilities, []),
            },
            lng, lat,
            x: el ? el.clientWidth / 2 : 300,
            y: el ? el.clientHeight / 2 : 300,
          })
        })
        .catch(() => { /* offline / missing data: link silently does nothing */ })
    }
  }, [mapReady])

  // Keep stopFlyingRef / teleportRef pointing at the current callbacks.
  useEffect(() => { stopFlyingRef.current    = stopFlying },    [stopFlying])
  useEffect(() => { teleportRef.current      = teleport },      [teleport])
  useEffect(() => { setSimTargetRef.current  = setSimTarget },  [setSimTarget])

  // Sync flyingMode → ref (used in map init closure) + enable/disable follow.
  useEffect(() => {
    flyingModeRef.current = flyingMode
    if (flyingMode !== 'off') {
      setFollowAircraft(true)
      setActiveWpIdx(1)
      autoZoomPhaseRef.current = 'idle'  // ready to detect takeoff
      autoZoomTargetRef.current = null
      setTrackedPoint(null)
    } else {
      setFollowAircraft(false)
      setShowModePicker(false)
      // Clear aircraft layer, glide ring, trajectory, and restore north-up bearing when mode stops.
      const map = mapRef.current
      if (map && mapReady) {
        ;(map.getSource('aircraft-position') as GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection', features: [],
        })
        ;(map.getSource('glide-range') as GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection', features: [],
        })
        ;(map.getSource('aircraft-trajectory') as GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection', features: [],
        })
        ;(map.getSource('extended-centrelines') as GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection', features: [],
        })
        map.easeTo({ bearing: 0, duration: 500 })
      }
    }
  }, [flyingMode, mapReady])

  // Load runway threshold data once (used for extended centrelines during Go Flying).
  useEffect(() => {
    if (!mapReady) return
    if (runwayThresholdsRef.current.length > 0) return  // already loaded
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-runway-thresholds.geojson'))
      .then(r => r.json())
      .then((fc: GeoJSON.FeatureCollection) => {
        runwayThresholdsRef.current = fc.features
          .filter(f => f.geometry.type === 'Point')
          .map(f => ({
            icao:     (f.properties as Record<string, unknown>).icao as string,
            lat:      (f.geometry as GeoJSON.Point).coordinates[1],
            lng:      (f.geometry as GeoJSON.Point).coordinates[0],
            mag_brg:  (f.properties as Record<string, unknown>).mag_brg as number,
            true_brg: ((f.properties as Record<string, unknown>).true_brg as number | undefined) ?? null,
          }))
      })
      .catch(() => { /* non-fatal */ })
  }, [mapReady])

  // Load towered-aerodrome hours once (used to periodically recolor the
  // 'aerodromes-atc-ring' layer -- see the effect below). Same fetch-once-
  // separately-from-the-map-source pattern as runway thresholds above.
  const [toweredAerodromesLoaded, setToweredAerodromesLoaded] = useState(false)
  useEffect(() => {
    if (!mapReady) return
    if (toweredAerodromesRef.current.length > 0) return  // already loaded
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-aerodromes.geojson'))
      .then(r => r.json())
      .then((fc: GeoJSON.FeatureCollection) => {
        toweredAerodromesRef.current = fc.features
          .filter(f => f.geometry.type === 'Point' && (f.properties as Record<string, unknown>).towered === true)
          .map(f => ({
            icao:  (f.properties as Record<string, unknown>).icao as string,
            lat:   (f.geometry as GeoJSON.Point).coordinates[1],
            lng:   (f.geometry as GeoJSON.Point).coordinates[0],
            hours: ((f.properties as Record<string, unknown>).hours_of_operation as AtcHoursEntry[] | undefined) ?? [],
          }))
      })
      .catch(() => { /* non-fatal -- ring just stays 'unknown' grey for everyone */ })
      .finally(() => setToweredAerodromesLoaded(true))
  }, [mapReady])

  // Recolor 'aerodromes-atc-ring' every 60s from the cached towered-aerodrome
  // list above. AIP-schedule-derived only (see @open-vfr/shared/atcStatus) --
  // deliberately never NOTAM-driven, matching AerodromePopup's same-source
  // badge. A per-ICAO 'match' expression is small (a few dozen towered fields
  // in Sweden today) so this is cheap even every tick.
  useEffect(() => {
    if (!mapReady) return
    const map = mapRef.current
    if (!map) return

    function applyAtcRingColors() {
      if (!map!.getLayer('aerodromes-atc-ring')) return
      const entries = toweredAerodromesRef.current
      if (entries.length === 0) return
      const now = new Date()
      const matchArgs: (string | number)[] = []
      for (const e of entries) {
        const sun = sunriseSunset(e.lat, e.lng, now)
        const { status } = computeAtcStatus(e.hours, sun, now)
        const color =
          status === 'open'   ? AERODROME_COLORS.atcOpen :
          status === 'closed' ? AERODROME_COLORS.atcClosed :
                                 AERODROME_COLORS.atcUnknown
        matchArgs.push(e.icao, color)
      }
      const expr: ExpressionSpecification =
        ['match', ['get', 'icao'], ...matchArgs, AERODROME_COLORS.atcUnknown] as unknown as ExpressionSpecification
      map!.setPaintProperty('aerodromes-atc-ring', 'circle-stroke-color', expr)
    }

    // Same-tick NOTAM keyword hint badge ('aerodromes-notam-hint' layer) --
    // one bulk request for every towered airport's active NOTAM texts (see
    // getAerodromeNotamTexts()/GET /api/notam/aerodrome-texts), then applies
    // isNotamAtcRelated/isNotamHoursChangeRelated client-side, same keyword
    // heuristics as AerodromePopup's text-only hint lines. Skipped entirely
    // while signed out (endpoint requires auth, matching /api/notam and
    // /api/notam/regional's own gating) -- badge layer just stays empty.
    async function applyNotamHints() {
      if (!map!.getLayer('aerodromes-notam-hint')) return
      if (!auth.user) {
        map!.setFilter('aerodromes-notam-hint', ['in', ['get', 'icao'], ['literal', []]])
        return
      }
      const towered = new Set(toweredAerodromesRef.current.map((e) => e.icao))
      if (towered.size === 0) return
      let texts: Record<string, string[]>
      try {
        texts = await fetchAerodromeNotamTexts(API_BASE_URL)
      } catch {
        return  // transient failure -- leave the previous hint state in place
      }
      const icaos: string[] = []
      const glyphArgs: (string | number)[] = []
      for (const [icao, icaoTexts] of Object.entries(texts)) {
        if (!towered.has(icao)) continue
        const atcHit   = icaoTexts.some((t) => isNotamAtcRelated(t))
        const hoursHit = icaoTexts.some((t) => isNotamHoursChangeRelated(t))
        if (!atcHit && !hoursHit) continue
        icaos.push(icao)
        glyphArgs.push(icao, atcHit && hoursHit ? '⚠⏰' : atcHit ? '⚠' : '⏰')
      }
      map!.setFilter('aerodromes-notam-hint', ['in', ['get', 'icao'], ['literal', icaos]])
      map!.setLayoutProperty(
        'aerodromes-notam-hint', 'text-field',
        icaos.length > 0
          ? (['match', ['get', 'icao'], ...glyphArgs, ''] as unknown as ExpressionSpecification)
          : '',
      )
    }

    applyAtcRingColors()
    void applyNotamHints()
    const interval = setInterval(() => { applyAtcRingColors(); void applyNotamHints() }, 60_000)
    return () => clearInterval(interval)
  }, [mapReady, toweredAerodromesLoaded, auth.user])

  // Sync gpsPosition → aircraft layer on map + optional centering.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !gpsPosition) return
    gpsPositionRef.current = gpsPosition

    // Update the aircraft symbol layer.
    ;(map.getSource('aircraft-position') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [gpsPosition.lng, gpsPosition.lat] },
        properties: { trackDeg: gpsPosition.trackDeg },
      }],
    })

    // Update glide range ring (only when aircraft profile has glide ratio configured).
    const glideRatio = selectedAircraftProfile?.glideRatio ?? 0
    const glideSource = map.getSource('glide-range') as GeoJSONSource | undefined
    if (glideSource) {
      if (glideRatio > 0 && gpsPosition.altFt > 200) {
        const radiusNm = (gpsPosition.altFt * glideRatio) / 6076.12
        glideSource.setData({ type: 'FeatureCollection', features: [makeCirclePolygon(gpsPosition.lat, gpsPosition.lng, radiusNm)] })
      } else {
        glideSource.setData({ type: 'FeatureCollection', features: [] })
      }
    }

    // Update trajectory line: main line + tick marks at 1, 3, 5 min or NM.
    // Hidden when speed is near-zero (prevents a random line while taxiing at 0 kts).
    const trajSource = map.getSource('aircraft-trajectory') as GeoJSONSource | undefined
    if (trajSource) {
      const spd = gpsPosition.speedKts
      if (spd >= 5) {
        const mode   = trajectoryModeRef.current
        // Distances in NM for each mark (time mode: minutes-ahead × speed, dist mode: NM directly)
        const marks  = mode === 'time'
          ? [1, 3, 5].map(min => (min / 60) * spd)
          : [1, 3, 5]
        const tip    = advancePosition(gpsPosition.lat, gpsPosition.lng, gpsPosition.trackDeg, marks[2])
        // Perpendicular bearing for tick marks
        const perpBrg = (gpsPosition.trackDeg + 90) % 360
        // Tick half-widths scale with distance so they look proportional at any zoom
        const TICK_WIDTHS_NM = [0.15, 0.2, 0.25]  // 1-min, 3-min, 5-min ticks
        const tickFeatures = marks.map((distNm, i) => {
          const centre = advancePosition(gpsPosition.lat, gpsPosition.lng, gpsPosition.trackDeg, distNm)
          const half   = TICK_WIDTHS_NM[i]
          const left   = advancePosition(centre.lat, centre.lng, (perpBrg + 180) % 360, half)
          const right  = advancePosition(centre.lat, centre.lng, perpBrg, half)
          return {
            type: 'Feature' as const,
            geometry: { type: 'LineString' as const, coordinates: [[left.lng, left.lat], [right.lng, right.lat]] },
            properties: { type: 'tick' },
          }
        })
        trajSource.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: [[gpsPosition.lng, gpsPosition.lat], [tip.lng, tip.lat]] },
              properties: { type: 'line' },
            },
            ...tickFeatures,
          ],
        })
      } else {
        trajSource.setData({ type: 'FeatureCollection', features: [] })
      }
    }

    // Auto-zoom: zoom to z13 on takeoff, fall back to z11 once airborne.
    // Manual map drag (which sets followAircraft=false) suspends auto-zoom
    // since we won't be centering anyway.

    // Update extended centrelines: show approach paths for airports within 10 NM.
    const centrelineSource = map.getSource('extended-centrelines') as GeoJSONSource | undefined
    if (centrelineSource) {
      if (runwayThresholdsRef.current.length > 0) {
        centrelineSource.setData(buildCentrelines(
          runwayThresholdsRef.current,
          gpsPosition.lat, gpsPosition.lng, gpsPosition.trackDeg,
          /* nearDistNm */ 10,
          /* lineNm */     5,
        ))
      }
    }
    // Folded into the follow easeTo below (not a separate easeTo call): a
    // second easeTo in the same tick interrupts the first, so a standalone
    // zoom animation was cancelled immediately by the follow pan.
    // The target is kept until its animation window elapses, so the next
    // GPS tick's follow easeTo (which interrupts the running one) carries
    // the zoom on instead of freezing it part-way.
    if (followAircraft && autoZoomRef.current) {
      const phase = autoZoomPhaseRef.current
      if (phase === 'idle' && gpsPosition.speedKts >= 30) {
        autoZoomPhaseRef.current = 'takeoff'
        autoZoomTargetRef.current = { zoom: 13, until: performance.now() + 1500 }
      } else if (phase === 'takeoff' && gpsPosition.speedKts >= 60) {
        autoZoomPhaseRef.current = 'cruise'
        autoZoomTargetRef.current = { zoom: 11, until: performance.now() + 2000 }
      }
    }
    const zt = autoZoomTargetRef.current
    const zoomLeftMs = zt ? zt.until - performance.now() : 0
    if (zt && zoomLeftMs <= 0) autoZoomTargetRef.current = null
    const autoZoom = zt && zoomLeftMs > 0 ? { zoom: zt.zoom, duration: Math.max(250, zoomLeftMs) } : null

    // Optionally pan / rotate to follow.
    if (followAircraft) {
      const legBearing =
        routeWaypoints.length >= 2 && activeWpIdx > 0 && activeWpIdx < routeWaypoints.length
          ? bearingDeg(routeWaypoints[activeWpIdx - 1], routeWaypoints[activeWpIdx])
          : gpsPosition.trackDeg
      const bearing =
        mapOrientation === 'track'  ? gpsPosition.trackDeg
        : mapOrientation === 'course' ? legBearing
        : 0
      // Track-/course-up: place the aircraft in the lower part of the screen
      // so most of the map shows what lies ahead rather than behind. easeTo's
      // `offset` is resolved against the *target* bearing, so it stays
      // correct while the map rotates. (maplibre's calculateAnchoredCameraOptions
      // was considered but holds bearing fixed, so it doesn't fit here.)
      // North-up keeps the aircraft centred -- "ahead" isn't a screen
      // direction there.
      const lookAheadPx = mapOrientation === 'north' ? 0 : Math.round(map.getContainer().clientHeight * FOLLOW_LOOKAHEAD_RATIO)
      map.easeTo({ center: [gpsPosition.lng, gpsPosition.lat], bearing, offset: [0, lookAheadPx], duration: 250, ...autoZoom })
    }
  }, [gpsPosition, mapReady, followAircraft, mapOrientation, routeWaypoints, activeWpIdx, selectedAircraftProfile])

  // Auto-advance active WP index when aircraft is within 0.3 NM of next WP.
  useEffect(() => {
    if (!gpsPosition || flyingMode === 'off' || routeWaypoints.length < 2) return
    const destWp = routeWaypoints[activeWpIdx]
    if (!destWp || activeWpIdx >= routeWaypoints.length - 1) return
    if (distanceNm(gpsPosition, destWp) < 0.3) {
      setActiveWpIdx(i => i + 1)
    }
  }, [gpsPosition, flyingMode, routeWaypoints, activeWpIdx])

  // Waypoint reminder — fire when activeWpIdx changes while flying.
  const [reminderNote, setReminderNote] = useState<{ text: string; wpName: string } | null>(null)
  useEffect(() => {
    if (flyingMode === 'off') return
    const wp = routeWaypoints[activeWpIdx]
    if (wp?.note) {
      setReminderNote({ text: wp.note, wpName: wp.name ?? `WP${activeWpIdx + 1}` })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWpIdx])

  // Flying button visual state (highlighted when active).
  useEffect(() => {
    const btn = flyingBtnRef.current
    if (!btn) return
    const active = flyingMode !== 'off'
    btn.style.backgroundColor = active ? 'rgba(168,85,247,0.85)' : ''
    btn.style.color            = active ? '#ffffff' : ''
    btn.title = active ? 'Stop flying' : 'Go Flying — GPS or Simulation'
  }, [flyingMode])

  // Memoise activeInfo so its reference only changes when activePopup changes.
  // Without this, the SideDrawer auto-open effect fires on every render
  // (inline JSX ternaries produce a new object each time), re-opening the
  // drawer immediately after the user closes it.
  const activeInfo = useMemo(() => {
    if (!activePopup) return null
    if (activePopup.kind === 'aerodrome')
      return { kind: 'aerodrome' as const, props: activePopup.props, lng: activePopup.lng, lat: activePopup.lat }
    if (activePopup.kind === 'airspace')
      return { kind: 'airspace' as const, features: activePopup.features, regionalNotams: activePopup.regionalNotams, focusKey: activePopup.focusKey }
    if (activePopup.kind === 'point')
      return { kind: 'point' as const, feature: activePopup.feature }
    if (activePopup.kind === 'whatshere')
      return { kind: 'whatshere' as const, items: activePopup.items, airspaceFeatures: activePopup.airspaceFeatures, lng: activePopup.lng, lat: activePopup.lat }
    return null
  }, [activePopup])

  return (
    <div className={css.wrapper}>
      {routeUndo.editSessionActive && (
        <RouteEditBanner
          canUndo={routeUndo.canUndo}
          canRedo={routeUndo.canRedo}
          onUndo={routeUndo.undo}
          onRedo={routeUndo.redo}
          onCancel={routeUndo.cancelEditSession}
          onApply={routeUndo.applyEditSession}
        />
      )}
      <SideDrawer
        visibility={visibility}
        onVisibilityChange={setVisibilityGroup}
        ceilingFt={ceilingFt}
        onCeilingChange={setCeilingFt}
        basemapMode={basemapMode}
        onBasemapModeChange={setBasemapMode}
        satelliteLocked={satelliteLocked}
        units={units}
        onUnitsChange={setUnits}
        region={region}
        onRegionChange={setRegion}
        theme={theme}
        onThemeChange={setTheme}
        autoZoom={autoZoom}
        onAutoZoomChange={setAutoZoom}
        trajectoryMode={trajectoryMode}
        onTrajectoryModeChange={setTrajectoryMode}
        airspaceWarnLookahead={airspaceWarnLookahead}
        onAirspaceWarnLookaheadChange={setAirspaceWarnLookahead}
        airspaceWarnVerticalFt={airspaceWarnVerticalFt}
        onAirspaceWarnVerticalFtChange={setAirspaceWarnVerticalFt}
        terrainColoring={terrainColoring}
        onTerrainColoringChange={setTerrainColoring}
        trafficVertFilter={trafficVertFilter}
        onTrafficVertFilterChange={setTrafficVertFilter}
        parkTimeout={parkTimeout}
        onParkTimeoutChange={setParkTimeout}
        inFlight={flyingMode !== 'off' && (gpsPosition?.speedKts ?? 0) >= 30}
        manifest={manifest}
        isOnline={isOnline}
        checking={checking}
        onRefresh={refreshManifest}
        waypoints={routeWaypoints}
        legOverrides={legOverrides}
        routeVisible={routeVisible}
        onToggleRouteVisible={() => setRouteVisible((v) => !v)}
        planningMode={planningMode}
        onTogglePlanningMode={() => setPlanningMode((m) => !m)}
        onUndo={routeUndo.undo}
        onRedo={routeUndo.redo}
        canUndo={routeUndo.canUndo && !routeEditLocked}
        canRedo={routeUndo.canRedo && !routeEditLocked}
        onClear={() => { setRouteWaypoints([]); setPlanningMode(false) }}
        onReplace={(wps) => setRouteWaypoints(wps)}
        onLoadRoute={(wps, ovr, aircraftId) => {
          loadRouteIntoMap(wps, ovr, aircraftId)
          if (aircraftId) setSelectedAircraftId(aircraftId)
          setPlanningMode(true)
          // Fit the camera to the newly-loaded route's extent -- mirrors
          // native's identical activeRouteId-keyed AviationMap effect.
          // Fired directly here (not from a separate effect watching
          // activeRouteId, unlike native) since this handler already runs
          // exactly once per load/Save-As/GPX-import and already has
          // mapRef in scope -- no cross-screen signal needed the way
          // native's separate Map/Flight-Plan tabs require.
          if (wps.length >= 2 && mapRef.current) {
            const lngs = wps.map((w) => w.lng)
            const lats = wps.map((w) => w.lat)
            mapRef.current.fitBounds(
              [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
              { padding: 80, maxZoom: 13, duration: 800 },
            )
          }
        }}
        activeRouteId={activeRouteId}
        onActiveRouteIdChange={setActiveRouteId}
        onRunwayWind={handleRunwayWind}
        regionalNotams={regionalNotamsAll}
        onShowNotamOnMap={handleShowNotamOnMap}
        onSetLegOverride={(idx, ovr) =>
          setLegOverrides((prev) => {
            const next = [...prev]
            next[idx] = ovr
            return next
          })
        }
        onSetWaypointNote={(wpIdx, note) =>
          setRouteWaypoints((prev) => {
            const next = [...prev]
            next[wpIdx] = { ...next[wpIdx], note: note || undefined }
            return next
          })
        }
        onAddToRoute={(wp) => setRouteWaypoints(p => [...p, wp])}
        activeInfo={activeInfo}
        onCloseInfo={() => setActivePopup(null)}
        isHome={(icao) => homeAirfield?.icao === icao}
        onSetHome={(icao, name, lng, lat) =>
          setHomeAirfield(homeAirfield?.icao === icao ? null : { icao, name, lng, lat })
        }
        selectedAircraftId={selectedAircraftId ?? undefined}
        selectedAircraftProfile={selectedAircraftProfile}
        onSelectAircraft={setSelectedAircraftId}
        onFlyTo={(r) => mapRef.current?.flyTo({ center: [r.lng, r.lat], zoom: r.kind === 'LL' ? 12 : 13, speed: 1.4 })}
        selectedLogId={selectedLogId}
        onSelectLog={setSelectedLogId}
        onClearLog={() => setSelectedLogId(null)}
        userWaypoints={userWaypoints}
        pendingUserWpCoords={pendingUserWpCoords}
        folderVisibility={folderVisibility}
        onUserWpCoordsConsumed={() => setPendingUserWpCoords(null)}
        onStartPlaceUserWp={() => { setPlacingUserWp(true); setPendingUserWpCoords(null) }}
        onSaveUserWaypoint={(wp) => { saveUserWaypoint(wp).catch(console.error) }}
        onDeleteUserWaypoint={(id) => { deleteUserWaypoint(id).catch(console.error) }}
        onRenameUserWaypoint={(id, name) => { renameUserWaypoint(id, name).catch(console.error) }}
        onMoveUserWpFolder={(id, folder) => { moveUserWpFolder(id, folder).catch(console.error) }}
        onFolderVisChange={(folder, visible) => setFolderVisibility(p => ({ ...p, [folder]: visible }))}
        onSaveHereUserWaypoint={(name, lng, lat) => {
          saveUserWaypoint({ name, lng, lat, folder: '' }).catch(console.error)
        }}
        auth={auth}
        onOpenProfile={() => setProfileOpen(true)}
      />
      <div className={css.mapArea}>
        <div ref={containerRef} className={css.map} />
        <MapInfoBar map={mapReady ? mapRef.current : null} ceilingFt={ceilingFt} units={units} />

      {/* ── Data-update notification banner ──────────────────────────── */}
      {hasUpdate && (
        <div className={css.updateBanner} role="status">
          <span className={css.updateBannerText}>Aviation data updated — reload to apply</span>
          <button
            className={css.updateBannerReload}
            onClick={async () => {
              markSeen()
              // GeoJSON tiles use a StaleWhileRevalidate service-worker cache
              // (vite.config.ts 'aviation-data') — a plain reload would serve
              // the stale cached copy instantly and only refresh it in the
              // background for the *next* reload. Purge it first so this
              // reload actually fetches the updated data from network.
              if ('caches' in window) {
                try {
                  await caches.delete('aviation-data')
                } catch {
                  // ignore — worst case the SWR cache serves stale data once more
                }
              }
              window.location.reload()
            }}
          >
            Reload
          </button>
          <button className={css.updateBannerDismiss} onClick={markSeen} aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* ── Outdated-AIRAC warning (non-blocking; shown in every mode) ── */}
      {!hasUpdate && outdatedAirac.length > 0 && dismissedAiracKey !== outdatedAiracKey && (
        <div className={`${css.updateBanner} ${css.staleBanner}`} role="status">
          <span className={css.updateBannerText}>
            ⚠ Airspace data outdated —{' '}
            {outdatedAirac.map(o => `${o.country.toUpperCase()} AIRAC ${o.cycle}`).join(', ')}
            {' '}(current {currentAirac}). Verify against official AIP.
          </span>
          <button
            className={css.updateBannerReload}
            onClick={refreshManifest}
            disabled={checking}
          >
            {checking ? 'Checking…' : 'Check for update'}
          </button>
          <button className={css.updateBannerDismiss} onClick={() => setDismissedAiracKey(outdatedAiracKey)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {snapPicker && (
        <SnapPicker
          candidates={snapPicker.candidates}
          x={snapPicker.x}
          y={snapPicker.y}
          onPick={(wp) => {
            const { insertAt, replaceMode } = snapPicker
            if (insertAt !== undefined && replaceMode) {
              setRouteWaypoints((p) => { const n = [...p]; n[insertAt] = wp; return n })
              dragMoveRef.current = null
            } else if (insertAt !== undefined) {
              setRouteWaypoints((p) => [...p.slice(0, insertAt), wp, ...p.slice(insertAt)])
              setLegOverrides((p) => { const n = [...p]; n.splice(insertAt, 0, p[insertAt - 1] ?? {}); return n })
              dragInsertRef.current = null
            } else {
              setRouteWaypoints((p) => [...p, wp])
            }
            setSnapPicker(null)
          }}
          onClose={() => {
            setSnapPicker(null)
            dragInsertRef.current = null
            dragMoveRef.current   = null
          }}
        />
      )}

      {/* ── Go Flying mode picker ─────────────────────────────────────── */}
      {showModePicker && flyingMode === 'off' && (
        <div className={css.modePicker}>
          <button
            className={css.modePickerGps}
            onClick={() => {
              setShowModePicker(false)
              setShowExtForm(false)
              startGps(() => {
                // GPS failed — re-show picker so user can choose sim
                setShowModePicker(true)
              })
            }}
          >
            📡 GPS
          </button>
          <button
            className={css.modePickerSim}
            onClick={() => {
              setShowModePicker(false)
              setShowExtForm(false)
              startSim(undefined, selectedAircraftProfileRef.current?.cruiseIas)
            }}
          >
            ▶ Keyboard Sim
          </button>
          {!showExtForm ? (
            <button
              className={css.modePickerExt}
              onClick={() => { setShowExtForm(true); setExtWsError(null) }}
            >
              🖥️ External Sim
            </button>
          ) : (
            <div className={css.modePickerExtForm}>
              <span className={css.modePickerExtLabel}>WebSocket URL</span>
              <input
                className={css.modePickerExtInput}
                value={extWsUrl}
                aria-label="WebSocket URL for external simulator"
                placeholder="ws://localhost:5104"
                onChange={e => {
                  setExtWsUrl(e.target.value)
                  localStorage.setItem('ovfr:extWsUrl', e.target.value)
                }}
                onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
                spellCheck={false}
                autoFocus
              />
              {extWsError && <span className={css.modePickerExtError}>{extWsError}</span>}
              <button
                className={css.modePickerExtConnect}
                onClick={() => {
                  setExtWsError(null)
                  startExt(extWsUrl, (msg) => {
                    setExtWsError(msg)
                    setShowModePicker(true)
                    setShowExtForm(true)
                  })
                  setShowModePicker(false)
                }}
              >
                Connect
              </button>
            </div>
          )}
          <button
            className={css.modePickerCancel}
            onClick={() => { setShowModePicker(false); setShowExtForm(false) }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── Consolidated notification stack (top-centre, severity-ordered) */}
      {flyingMode !== 'off' && (
        <NotificationCenter
          airspaceAlerts={airspaceAlerts}
          onDismissAirspace={dismissAlert}
          obstructionAlerts={obstructionAlerts}
          onDismissObstruction={dismissObstruction}
          airfieldAlerts={airfieldAlerts}
          onDismissAirfield={dismissAirfield}
          airspaceNotifications={airspaceNotifications}
          notamAlerts={notamAlerts}
          onDismissNotam={dismissNotam}
          notamNotifications={notamNotifications}
          ceilingMsg={ceilingEscalatedMsg}
          reminderNote={reminderNote}
          onDismissReminder={() => setReminderNote(null)}
        />
      )}

      {/* ── Airfield Brief panel ──────────────────────────────────────── */}
      {flyingMode !== 'off' && airfieldBrief && airfieldBrief.icao !== briefDismissed && (
        <AirfieldBriefPanel
          brief={airfieldBrief}
          onOpenFull={(props, lat, lng) => {
            const el = containerRef.current
            const cx = el ? el.clientWidth  / 2 : 300
            const cy = el ? el.clientHeight / 2 : 300
            setActivePopup({ kind: 'aerodrome', props, lat, lng, x: cx, y: cy })
          }}
          onClose={() => setBriefDismissed(airfieldBrief.icao || airfieldBrief.name)}
        />
      )}

      {/* ── Live Pilot Log panel ──────────────────────────────────────── */}
      {flyingMode !== 'off' && showPlog && routeWaypoints.length >= 2 && (
        <LivePlogPanel
          waypoints={routeWaypoints}
          activeWpIdx={activeWpIdx}
          plogData={plogData}
          onClose={() => setShowPlog(false)}
        />
      )}

      {/* ── In-flight waypoint action menu (adjust mode tap) ─────────── */}
      {wpMenu && routeAdjustMode && (
        <WpActionMenu
          wpIdx={wpMenu.wpIdx}
          waypoints={routeWaypoints}
          activeWpIdx={activeWpIdx}
          x={wpMenu.x}
          y={wpMenu.y}
          canvasW={containerRef.current?.clientWidth  ?? window.innerWidth}
          canvasH={containerRef.current?.clientHeight ?? window.innerHeight}
          onDirectTo={(idx) => {
            // Cut the route: keep origin (wp 0) or current active, then skip to idx
            setRouteWaypoints(prev => {
              const before = prev.slice(0, activeWpIdx)
              const after  = prev.slice(idx)
              return [...before, ...after]
            })
            // activeWpIdx stays the same — the waypoint at that index is now idx
          }}
          onRemove={(idx) => {
            setRouteWaypoints(prev => prev.filter((_, i) => i !== idx))
            setLegOverrides(prev => {
              const next = [...prev]
              next.splice(idx, 1)
              return next
            })
            // Clamp activeWpIdx if needed
            if (activeWpIdx >= routeWaypoints.length - 1) {
              setActiveWpIdx(Math.max(1, routeWaypoints.length - 2))
            }
          }}
          onClose={() => setWpMenu(null)}
        />
      )}

      {/* ── Long-press leg action menu (planning mode + adjust mode) ─── */}
      {legMenu && (
        <LegActionMenu
          lngLat={legMenu.lngLat}
          legIndex={legMenu.legIndex}
          waypointCount={routeWaypoints.length}
          activeWpIdx={routeAdjustMode ? activeWpIdx : -1}
          x={legMenu.x}
          y={legMenu.y}
          canvasW={containerRef.current?.clientWidth  ?? window.innerWidth}
          canvasH={containerRef.current?.clientHeight ?? window.innerHeight}
          onInsert={(ll, legIndex) => {
            setRouteWaypoints(prev => [
              ...prev.slice(0, legIndex + 1),
              { lng: ll.lng, lat: ll.lat },
              ...prev.slice(legIndex + 1),
            ])
            setLegOverrides(prev => {
              const next = [...prev]
              const inherited = next[legIndex] ?? {}
              next.splice(legIndex + 1, 0, inherited)
              return next
            })
          }}
          onAppend={(ll) => {
            setRouteWaypoints(prev => [...prev, { lng: ll.lng, lat: ll.lat }])
            setLegOverrides(prev => [...prev, {}])
          }}
          onShortcut={(ll, legIndex) => {
            // Replace route from activeWpIdx onward with [pressed point, next original WP...]
            setRouteWaypoints(prev => {
              const before = prev.slice(0, activeWpIdx)
              const after  = prev.slice(legIndex + 1)
              return [...before, { lng: ll.lng, lat: ll.lat }, ...after]
            })
            setLegOverrides(prev => {
              const before = prev.slice(0, activeWpIdx)
              const after  = prev.slice(legIndex + 1)
              return [...before, {}, ...after]
            })
            // activeWpIdx stays — the new WP at activeWpIdx becomes the target
          }}
          onClose={() => setLegMenu(null)}
        />
      )}

      {/* ── Direct To panel ───────────────────────────────────────────── */}
      {showDirectTo && flyingMode !== 'off' && gpsPosition && (
        <DirectToPanel
          position={gpsPosition}
          homeIcao={homeAirfield?.icao ?? null}
          aircraftProfile={selectedAircraftProfile}
          onDirectTo={(wp) => {
            // Replace route with [current position → chosen aerodrome]
            setRouteWaypoints([
              { lat: gpsPosition.lat, lng: gpsPosition.lng, name: 'Position' },
              wp,
            ])
            setActiveWpIdx(1)
          }}
          onClose={() => setShowDirectTo(false)}
        />
      )}

      {/* ── Find a Destination panel ──────────────────────────────────── */}
      {showFindDest && (() => {
        // Use GPS position when airborne, otherwise map centre.
        const mc = mapRef.current?.getCenter()
        const centre = gpsPosition
          ? { lat: gpsPosition.lat, lng: gpsPosition.lng, altFt: gpsPosition.altFt }
          : mc
          ? { lat: mc.lat, lng: mc.lng }
          : { lat: 59.33, lng: 18.07 }  // fallback: Stockholm
        return (
          <FindDestPanel
            center={centre}
            homeIcao={homeAirfield?.icao ?? null}
            aircraftProfile={selectedAircraftProfile}
            onFlyTo={(lat, lng) => {
              mapRef.current?.flyTo({ center: [lng, lat], zoom: 13, speed: 1.4 })
            }}
            onAddToRoute={(wp) => {
              setRouteWaypoints(p => [...p, wp])
              setPlanningMode(true)
            }}
            onClose={() => setShowFindDest(false)}
          />
        )
      })()}

      {/* \u2500\u2500 Airfield Brief panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */}
      {showVicinityBrief && (
        <VicinityBriefPanel
          nearbyFreqs={nearbyFreqs}
          aerodromes={vicinityAerodromes}
          isHome={(icao) => homeAirfield?.icao === icao}
          authed={!!auth.user}
          onSetHome={(icao, name, lng, lat) =>
            setHomeAirfield(homeAirfield?.icao === icao ? null : { icao, name, lng, lat })
          }
          onRunwayWind={handleRunwayWind}
          regionalNotams={regionalNotamsAll}
          routeWaypoints={routeWaypoints}
          onShowNotamOnMap={handleShowNotamOnMap}
          onClose={() => setShowVicinityBrief(false)}
        />
      )}
      </div>

      {/* ── In-flight instruments (GoFlyingPanel) — own grid row ──────── */}
      {flyingMode !== 'off' && gpsPosition && (
        <div className={css.gfpRow}>
          <GoFlyingPanel
          mode={flyingMode}
          position={gpsPosition}
          wind={liveWind}
          nextWp={routeWaypoints[activeWpIdx] ?? null}
          remainingWaypoints={routeWaypoints.slice(activeWpIdx)}
          orientation={mapOrientation}
          positionReport={nearestFeature}
          onOpenDirectTo={() => setShowDirectTo(true)}
          onDropWaypoint={() => {
            const pos = gpsPositionRef.current
            if (!pos) return
            const name = `Drop ${new Date().toUTCString().slice(17, 22)}z`
            saveUserWaypoint({ name, lat: pos.lat, lng: pos.lng, folder: 'Dropped in Flight' })
          }}
          onTrackToggle={() => {
            if (trackedPoint) {
              setTrackedPoint(null)
            } else if (nearestFeature) {
              // Convert NearestFeature to TrackedPoint using current position
              const pos = gpsPositionRef.current
              if (!pos) return
              // Find the geographic coords of the nearest feature from the rendered nearest
              // We store the ICAO/name which is sufficient — pass it as lat/lng approximation
              // by going back via the nearest feature data. For simplicity we compute
              // the projected point from bearing + distance.
              const brg = nearestFeature.bearingTrue * Math.PI / 180
              const d   = nearestFeature.distNm / 3440.065
              const lat1 = pos.lat * Math.PI / 180
              const lng1 = pos.lng * Math.PI / 180
              const lat2 = Math.asin(Math.sin(lat1)*Math.cos(d) + Math.cos(lat1)*Math.sin(d)*Math.cos(brg))
              const lng2 = lng1 + Math.atan2(Math.sin(brg)*Math.sin(d)*Math.cos(lat1), Math.cos(d)-Math.sin(lat1)*Math.sin(lat2))
              setTrackedPoint({
                lat:  lat2 * 180 / Math.PI,
                lng:  ((lng2 * 180 / Math.PI) + 540) % 360 - 180,
                name: nearestFeature.name,
                kind: nearestFeature.kind,
              })
            }
          }}
          isTracking={trackedPoint !== null}
          onOpenPlog={() => setShowPlog(v => !v)}
          plogOpen={showPlog}
          onAdjustRoute={() => setRouteAdjustMode(v => !v)}
          adjustMode={routeAdjustMode}
          onOrientationChange={(o) => {
            setMapOrientation(o)
            // If following, immediately re-orient the map.
            const pos = gpsPositionRef.current
            const map = mapRef.current
            if (followAircraft && pos && map) {
              const legBearing =
                routeWaypoints.length >= 2 && activeWpIdx > 0 && activeWpIdx < routeWaypoints.length
                  ? bearingDeg(routeWaypoints[activeWpIdx - 1], routeWaypoints[activeWpIdx])
                  : pos.trackDeg
              const bearing =
                o === 'track'  ? pos.trackDeg
                : o === 'course' ? legBearing
                : 0
              map.easeTo({ bearing, duration: 400 })
            }
          }}
          followAircraft={followAircraft}
          onFollow={() => {
            setFollowAircraft(true)
            const pos = gpsPositionRef.current
            const map = mapRef.current
            if (pos && map) {
              map.flyTo({ center: [pos.lng, pos.lat], speed: 2 })
            }
          }}
          onStop={stopFlying}
        />
        </div>
      )}

      {/* VirtualRadar: ruler profile → past-log review → planned route → look-ahead (unplanned flight) */}
      {showRulerProfile ? (
        <div className={css.vrRow}>
          <RulerSummaryStrip
            from={rulerPoints[0]}
            to={rulerPoints[1]}
            units={units}
            aircraftProfile={selectedAircraftProfile}
            onClear={() => { setRulerPoints([]); setRulerMode(false) }}
          />
          <VirtualRadar
            waypoints={rulerPoints}
            legOverrides={[]}
            units={units}
            airspaceCeilingFt={ceilingFt}
            aircraftProfile={selectedAircraftProfile}
            onHoverDistNm={setProfileCursorNm}
            weatherStations={rulerWeatherStations}
          />
        </div>
      ) : selectedLogId && selectedLogTrack.length > 0 ? (
        // Past-log review: show the recorded track chart, even when a planned route exists.
        // The route stays visible on the map but the bottom panel belongs to the flight log.
        <div className={css.vrRow}>
          <LiveTrackChart track={selectedLogTrack} onHoverDistNm={setProfileCursorNm} />
        </div>
      ) : routeWaypoints.length >= 2 ? (
        <div className={css.vrRow}>
          <VirtualRadar
            waypoints={routeWaypoints}
            legOverrides={legOverrides}
            units={units}
            airspaceCeilingFt={ceilingFt}
            aircraftProfile={selectedAircraftProfile}
            currentDistNm={aircraftDistNm}
            currentAltFt={flyingMode !== 'off' ? gpsPosition?.altFt : undefined}
            currentSpeedKts={flyingMode !== 'off' ? gpsPosition?.speedKts : undefined}
            currentVSpeedFpm={flyingMode !== 'off' ? gpsVSpeedFpm ?? undefined : undefined}
            crossTrackNm={crossTrackNm}
            weatherStations={routeWeatherStations}
            windSamples={routeWindSamples}
            trajectoryMode={trajectoryMode}
            onHoverDistNm={setProfileCursorNm}
            crosshairDistNm={profileCursorNm}
          />
        </div>
      ) : flyingMode !== 'off' ? (
        // Flying without a planned route: show forward-looking profile along current heading.
        // Falls back to the live track chart while the first look-ahead route is initialising.
        lookaheadWaypoints.length >= 2 ? (
          <div className={css.vrRow}>
            <VirtualRadar
              title={`LOOK-AHEAD · TRK ${Math.round(lookaheadHeadingDeg)}°`}
              waypoints={lookaheadWaypoints}
              legOverrides={[{ altFt: gpsPosition?.altFt ?? 1000, speedKts: gpsPosition?.speedKts || selectedAircraftProfile?.cruiseIas || 90 }] as LegOverride[]}
              units={units}
              airspaceCeilingFt={ceilingFt}
              aircraftProfile={selectedAircraftProfile}
              currentDistNm={lookaheadDistNm}
              currentAltFt={gpsPosition?.altFt}
              currentSpeedKts={gpsPosition?.speedKts}
              currentVSpeedFpm={gpsVSpeedFpm ?? undefined}
              weatherStations={routeWeatherStations}
              trajectoryMode={trajectoryMode}
              onHoverDistNm={setProfileCursorNm}
              crosshairDistNm={profileCursorNm}
            />
          </div>
        ) : (
          <div className={css.vrRow}>
            <LiveTrackChart track={liveTrack} />
          </div>
        )
      ) : null}

      {profileOpen && <ProfilePanel auth={auth} onClose={() => setProfileOpen(false)} />}
    </div>
  )
}

