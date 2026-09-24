/**
 * Server and tile configuration.
 *
 * In development the React Native Metro server runs on your workstation.
 * The aviation data is served by the web Vite dev server (port 5173).
 */
import { layers, LIGHT } from '@protomaps/basemaps'
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec'

import { Platform } from 'react-native'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'

const devBase =
  Platform.OS === 'android'
    // adb reverse tcp:5200 tcp:5200 (see build:android:device) forwards the
    // device's localhost:5200 to the host workstation — no LAN IP needed,
    // and unlike a hardcoded LAN IP this never goes stale when the
    // workstation reconnects to Wi-Fi and gets a new address.
    ? (process.env.EXPO_PUBLIC_API_BASE_ANDROID ?? 'http://localhost:5200')
    : 'http://localhost:5200'

/** Base URL of the open-vfr API server (auth, weather, NOTAM). Override via EXPO_PUBLIC_API_BASE. */
export const API_BASE: string =
  (process.env.EXPO_PUBLIC_API_BASE ?? '') || devBase

/** Base URL for static GeoJSON tile files (served by Vite in dev, nginx in prod).
 *  Defaults to `${API_BASE}/tiles` (matches the local Docker/Vite dev
 *  server's /tiles/* route) when unset. Production always sets
 *  EXPO_PUBLIC_TILE_BASE explicitly to the bare tiles.openvfr.org R2
 *  domain (no /tiles suffix -- files sit at the bucket root there).
 *  Override via EXPO_PUBLIC_TILE_BASE. */
export const TILE_BASE: string =
  (process.env.EXPO_PUBLIC_TILE_BASE ?? '') || `${API_BASE}/tiles`

/**
 * Base URL for the OpenSky traffic endpoints (/api/traffic/*).
 *
 * Defaults to API_BASE, but you should override this explicitly in most
 * self-hosted setups: the traffic poller typically runs against a single
 * OpenSky account with a tight daily credit quota (see apps/api/src/traffic.ts).
 * Running a second independent poller from local dev would silently
 * double-burn that account's quota using the same OpenSky credentials.
 * Local dev should read live traffic from an already-running poller
 * instead of starting its own, unless you've configured a separate OpenSky
 * account for the local docker-compose `api` service.
 * Override via EXPO_PUBLIC_TRAFFIC_BASE.
 */
export const TRAFFIC_BASE: string =
  (process.env.EXPO_PUBLIC_TRAFFIC_BASE ?? '') || API_BASE

/** Base URL for Martin vector tile server.
 *  Dev: TILE_BASE with its port swapped to :5100 (requires `adb reverse tcp:5100 tcp:5100`).
 *  Prod: nginx proxies Martin at /martin (see docker-compose.yml + docker/nginx.conf),
 *  so when TILE_BASE has no explicit port (e.g. a bare https:// domain) the port-swap
 *  regex can't match — append /martin instead. Without this branch MARTIN_BASE silently
 *  fell back to TILE_BASE unchanged, and MapLibre would request landuse tiles from the
 *  web app's root and get back HTML, producing "unknown pbf field type exception".
 *  Override via EXPO_PUBLIC_MARTIN_BASE.
 *
 *  Currently unused — landuse (the last consumer) moved to LANDUSE_PMTILES_URL
 *  below (static R2 file, retired from Postgres/Martin). Kept, not deleted:
 *  Martin still exists as a service for genuinely-dynamic future data
 *  (NOTAM/METAR/live airspace activation, user-generated content), so this
 *  constant will have a real consumer again once one of those ships. */
export const MARTIN_BASE: string =
  (process.env.EXPO_PUBLIC_MARTIN_BASE ?? '') ||
  (/:(\d{4,5})(\/|$)/.test(TILE_BASE)
    ? TILE_BASE.replace(/:(\d{4,5})(\/|$)/, ':5100$2')
    : `${TILE_BASE.replace(/\/$/, '')}/martin`)

/**
 * GeoJSON tile URLs — same files served by the web project.
 *
 * TILE_BASE is expected to be the *complete* base (including any path
 * segment the host needs), same convention as web's TILES_BASE_URL --
 * no extra path segment is appended here. Local dev's default TILE_BASE
 * (devBase, below) already includes the trailing /tiles it needs; in
 * production TILE_BASE should be set to the bare tiles.openvfr.org R2
 * domain (files live at its bucket root, no /tiles/ prefix -- see
 * docs/cloudflare-hosting.md). A hardcoded /tiles/ segment here used to
 * silently 404 every tile fetch against real production tiles.openvfr.org,
 * since it only ever got exercised against local dev hosts that happen to
 * route /tiles/* themselves.
 */
const TILE_FILENAMES = {
  airspace:          'se-airspace.geojson',
  aerodromes:        'se-aerodromes.geojson',
  navaids:           'se-navaids.geojson',
  waypoints:         'se-waypoints.geojson',
  runways:           'se-runways.geojson',
  runwayThresholds:  'se-runway-thresholds.geojson',
  obstacles:         'se-obstacles.geojson',
  landmarks:         'se-landmarks.geojson',
  water:             'se-water.geojson',
} as const

/**
 * BUG FIX: this used to be a plain top-level const object of unversioned
 * URLs, computed once at module import time -- meaning even after adding
 * loadTileManifest()/versionedTileUrl() support below, a const object would
 * have permanently frozen in whatever it resolved to at first import
 * (almost always before the manifest fetch in index.js resolves). Web's
 * equivalent (map-style.ts) avoids this because getMapStyle() is already a
 * function called lazily at map-mount time, well after main.tsx kicks off
 * loadTileManifest(). TILE_URLS is now a function for the same reason --
 * call sites (AviationMap.tsx's getResolvedTileUrls(), offlineCache.ts)
 * call it at component-mount/download time instead of import time, by
 * which point the manifest has almost always already resolved. Falls back
 * to a plain unversioned URL gracefully if it hasn't (see versionedTileUrl's
 * own doc comment) -- never breaks a fetch, just risks a stale CDN cache
 * entry in that narrow first-launch window, exactly like web.
 *
 * BUG FOUND LIVE (device): with no versioning at all, a stale CDN/OkHttp
 * cache entry for se-obstacles.geojson kept serving pre-fix obstacle
 * classification data indefinitely after openvfr-infra's classifier was
 * fixed and the file was re-uploaded to R2 -- web (already versioned)
 * picked up the fix immediately, native did not, despite fetching the exact
 * same underlying R2 object.
 */
export function getTileUrls(): Record<keyof typeof TILE_FILENAMES, string> {
  const out = {} as Record<keyof typeof TILE_FILENAMES, string>
  for (const k of Object.keys(TILE_FILENAMES) as (keyof typeof TILE_FILENAMES)[]) {
    out[k] = versionedTileUrl(TILE_BASE, TILE_FILENAMES[k])
  }
  return out
}

/** @deprecated use getTileUrls() -- kept only so TILE_FILENAMES' plain keys
 *  are still usable for code that only needs the filename, not a full URL
 *  (offlineCache.ts's fileName field). Do NOT reintroduce a top-level const
 *  URL map here -- see getTileUrls()'s doc comment for why. */
export { TILE_FILENAMES }

/**
 * Landuse PMTiles URL — retired from Postgres/Martin (was
 * `${MARTIN_BASE}/landuse_tiles/{z}/{x}/{y}?country=SE`), now a static
 * per-country .pmtiles file from object storage, same pattern as
 * `createProtomapsStyle`'s basemap.pmtiles below. See
 * apps/web/src/styles/map-style.ts `getLanduseSource()` and
 * docs/self-hosting.md.
 *
 * MapLibre Native 11+'s <VectorSource> accepts a `url` prop directly
 * (TileJSON/pmtiles), same as the `tiles` array it replaces here — no
 * separate protocol registration needed beyond what basemap.pmtiles already
 * requires.
 */
export function getLandusePmtilesUrl(): string {
  return `pmtiles://${versionedTileUrl(TILE_BASE, 'se-landuse.pmtiles')}`
}

/**
 * Relief hillshade raster-dem PMTiles (Terrarium encoding), same static file
 * generated by scripts/hillshade_to_pmtiles.sh and shipped alongside
 * basemap.pmtiles / se-landuse.pmtiles. Wired into AviationMap.tsx via
 * <RasterDEMSource>/<Layer type="hillshade"> (toggle: MapDisplaySheet's
 * Terrain section, LayerState.hillshade) and offlineCache.ts's optional
 * asset list. Verified supported on both platforms at the native binary
 * level, not just the JS type declarations — see AGENTS.md MapLibre RN
 * gotchas.
 */
export function getHillshadePmtilesUrl(): string {
  return `pmtiles://${versionedTileUrl(TILE_BASE, 'se-hillshade.pmtiles')}`
}

/**
 * Vector contour-line PMTiles (source-layer 'contours', `elev_m` property),
 * same static file generated by scripts/contours_to_pmtiles.sh. Unlike
 * HILLSHADE_PMTILES_URL above, actual <VectorSource>/<Layer type="line">
 * + <Layer type="symbol"> wiring in the native map component is NOT yet
 * done — config wired for offline caching only so far.
 */
export function getContoursPmtilesUrl(): string {
  return `pmtiles://${versionedTileUrl(TILE_BASE, 'se-contours.pmtiles')}`
}

/**
 * MapLibre GL style URL for the basemap.
 *
 * OpenFreeMap (https://openfreemap.org) is a completely free, no-API-key
 * service built on the same Protomaps/OpenMapTiles stack as the web basemap.
 * ODbL licence; self-hostable.
 *
 * Alternatives (also free, no key):
 *   - 'https://tiles.openfreemap.org/styles/bright'
 *   - 'https://tiles.openfreemap.org/styles/positron'
 */
export const BASEMAP_STYLE_URL =
  (process.env.EXPO_PUBLIC_BASEMAP_URL ?? '') ||
  'https://tiles.openfreemap.org/styles/liberty'

/** ESRI World Imagery — free XYZ satellite tiles, no API key. */
export const SATELLITE_STYLE = {
  version: 8 as const,
  sources: {
    satellite: {
      type: 'raster' as const,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 18,
      attribution: 'Tiles © Esri',
    },
  },
  layers: [{ id: 'satellite', type: 'raster' as const, source: 'satellite' }],
}

/**
 * Protomaps basemap style — identical to the web PWA.
 * Tiles are served from the Vite dev server (same PMTiles file).
 * In production, TILE_BASE points to the hosted server.
 *
 * MapLibre Native 11+ supports pmtiles:// natively.
 * URL format: pmtiles://<http(s)-url-of-pmtiles-file>
 */
export function createProtomapsStyle(pmtilesOverrideUrl?: string, overviewOverrideUrl?: string): StyleSpecification {
  const pmtilesUrl = `pmtiles://${pmtilesOverrideUrl ?? versionedTileUrl(TILE_BASE, 'basemap.pmtiles')}`
  // Shared low-zoom (z0-6) Europe-wide overview -- single file, built once,
  // NOT country-specific (unlike basemap.pmtiles, now country-bbox z7-12
  // detail only -- see openvfr-infra prepare-tiles.sh). Never affected by
  // pmtilesOverrideUrl (dev-server local-file override applies only to the
  // detail archive). Kept in sync with apps/web/src/styles/map-style.ts's
  // identical split -- see that file's own comment for the full rationale
  // (previously bare gray canvas past the country bbox edge, with regional
  // NOTAM pins still rendering there independent of basemap coverage).
  const overviewUrl = `pmtiles://${overviewOverrideUrl ?? versionedTileUrl(TILE_BASE, 'europe-overview.pmtiles')}`
  return {
    version: 8,
    // BUG FIX (found live on device): raw protomaps.github.io (GitHub Pages)
    // hit a transient DNS resolution failure ("Unable to resolve host
    // protomaps.github.io: No address associated with hostname", confirmed
    // via MapLibre Native's own console error), causing glyph ranges to fail
    // loading mid-session -- symbol text with missing glyphs renders garbled/
    // partially blank, which looked like something drawing over map labels.
    // jsDelivr's GitHub CDN mirror serves the identical files (same repo,
    // verified byte-identical response) over a proper global CDN with much
    // better DNS/edge reliability than GitHub Pages directly. Same content,
    // same license (protomaps/basemaps-assets is open). Matches web's
    // map-style.ts (kept in sync -- see that file's own comment).
    // TODO(openvfr-infra): fully self-host fonts+sprites on tiles.openvfr.org
    // instead, matching basemap.pmtiles/landuse/hillshade/contours' existing
    // no-external-runtime-dependency pattern -- this mirror swap is a stopgap.
    glyphs:  'https://cdn.jsdelivr.net/gh/protomaps/basemaps-assets@main/fonts/{fontstack}/{range}.pbf',
    sprite:  'https://cdn.jsdelivr.net/gh/protomaps/basemaps-assets@main/sprites/v4/light',
    sources: {
      protomaps: {
        type:        'vector',
        url:         pmtilesUrl,
        attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      } as StyleSpecification['sources'][string],
      'protomaps-overview': {
        type:        'vector',
        url:         overviewUrl,
        maxzoom:     6,
        attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      } as StyleSpecification['sources'][string],
    },
    layers: [
      // Painted first (bottom) so it only shows through past the detail
      // source's country bbox / below its z7 floor. 'ov-' id prefix avoids
      // collisions -- two vector sources can't share layer ids in one style.
      ...(layers('protomaps-overview', LIGHT, { lang: 'sv' }) as StyleSpecification['layers']).map(
        (l) => ({ ...l, id: `ov-${l.id}`, maxzoom: 7 }),
      ),
      ...(layers('protomaps', LIGHT, { lang: 'sv' }) as StyleSpecification['layers']),
    ],
  }
}

/** Default map centre — Sweden */
export const DEFAULT_CENTER: [number, number] = [17.0, 62.0]  // [lng, lat]
export const DEFAULT_ZOOM = 5

/** Airspace ceiling default (FL095 = 9,500 ft) */
export const DEFAULT_AIRSPACE_CEILING_FT = 9_500
