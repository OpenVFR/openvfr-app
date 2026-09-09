# Self-hosting OpenVFR

This repository contains the full application (web PWA, native app, API
server, database schema) but **not** the map/aviation data itself. That
data is large (hundreds of MB to GB), refreshed on its own cadence
(AIRAC cycles for airspace/aerodromes, monthly for OSM-derived layers,
effectively-static for terrain), and produced by a separate data-prep
pipeline that isn't part of this repository.

To self-host a fully working instance, you need to (1) run the app stack
in this repo, and (2) generate the data files below yourself and place
them where the app expects them.

## 1. Run the app stack

```sh
pnpm install
docker compose up -d db martin api postgrest
pnpm dev
```

See the root [README.md](../README.md) and [`apps/native/README.md`](../apps/native/README.md)
for web/native dev details, and `docker-compose.yml` for the full service
list (PostGIS, Martin tile server, Hono API, PostgREST).

## 2. Generate the map/aviation data

The app expects the following files in `apps/web/public/tiles/` (web) —
native reads the same files over HTTP from wherever you serve them (see
`apps/native/src/config.ts`'s `TILE_BASE`):

| File | Format | Contents |
|---|---|---|
| `basemap.pmtiles` | PMTiles | OSM-derived vector basemap |
| `se-airspace.geojson` | GeoJSON | Airspace polygons (class, type, altitudes) |
| `se-aerodromes.geojson` | GeoJSON | Aerodrome points + runway/frequency data |
| `se-navaids.geojson` | GeoJSON | VOR/NDB points |
| `se-waypoints.geojson` | GeoJSON | Named VFR reporting/mandatory points |
| `se-runways.geojson` | GeoJSON | Runway centerlines |
| `se-obstacles.geojson` | GeoJSON | Obstacle points (towers, turbines, etc.) |
| `se-landmarks.geojson` | GeoJSON | Visual landmarks (churches, masts, water towers) |
| `se-aeroways.geojson` | GeoJSON | Taxiways/aprons/unlabelled runways |
| `se-water.geojson` | GeoJSON | Water polygons |
| `se-landuse.pmtiles` | PMTiles | Landuse polygons (farmland/residential/etc.), tiled |
| `se-hillshade.pmtiles` | PMTiles (raster-dem, Terrarium encoding) | Relief shading |
| `se-contours.pmtiles` | PMTiles (vector) | Elevation isolines |
| `manifest.json` | JSON | Content hashes per file, for cache-busting (see `packages/shared/src/tileManifest.ts`) |

Filenames are per-country (`se-*` = Sweden); see `apps/web/src/styles/map-style.ts`
for the exact source/layer wiring and `docs/architecture.md`'s data table
for the property schema each file needs.

### Data sources (all open-licensed — see root README's Data & attribution)

- **Airspace / aerodromes / navaids / waypoints / runways**: [OpenFlightMaps](https://www.openflightmaps.org/)
  OFMX + ShapeExtension XML feeds.
- **Obstacles**: [OpenAIP](https://www.openaip.net/) (requires a free API key).
- **Landmarks / landuse / water / aeroways**: [OpenStreetMap](https://www.openstreetmap.org/copyright)
  via a country `.osm.pbf` extract (e.g. [Geofabrik](https://download.geofabrik.de/)),
  filtered with [osmium-tool](https://osmcode.org/osmium-tool/).
- **Basemap**: [Protomaps](https://protomaps.com/) (`@protomaps/basemaps`),
  or any other Protomaps/OpenMapTiles-schema PMTiles basemap build.
- **Hillshade / contours**: [Copernicus DEM GLO-30](https://registry.opendata.aws/copernicus-dem/),
  converted to Terrarium-RGB raster-dem PMTiles (hillshade) and vector
  isolines via `gdal_contour` (contours).

### High-level pipeline

The general shape of a data-prep pipeline for each dataset type:

1. **Vector aviation data (airspace/aerodromes/navaids/waypoints/runways)**:
   parse OFMX + ShapeExtension XML into GeoJSON matching the property
   schema in `docs/architecture.md`.
2. **Obstacles**: fetch from OpenAIP's REST API, convert to GeoJSON.
3. **OSM-derived layers (landmarks/landuse/water/aeroways)**: download a
   country `.osm.pbf` extract, filter with `osmium tags-filter` /
   `osmium export` for the relevant tags, convert to GeoJSON.
4. **Landuse tiling**: raw landuse GeoJSON is large (hundreds of MB) — tile
   it into PMTiles with [tippecanoe](https://github.com/felt/tippecanoe)
   (source-layer name: `landuse`).
5. **Terrain**: download Copernicus GLO-30 DEM tiles for your region, mosaic,
   then either encode as Terrarium-RGB PNG raster-dem PMTiles (hillshade)
   or extract vector isolines with `gdal_contour` and tile with tippecanoe
   (contours, source-layer `contours`, `elev_m` property).
6. **Manifest**: compute a sha256 per output file and write `manifest.json`
   in the shape `packages/shared/src/tileManifest.ts` expects, so the app's
   cache-busting/update-check logic works.
7. Drop all output files into `apps/web/public/tiles/` for local dev, or
   your own object storage / static file host in production (set
   `VITE_TILES_BASE_URL` / `EXPO_PUBLIC_TILE_BASE` to point at it).

Automation for this pipeline (cron scheduling, incremental refresh,
region-bbox tables, etc.) is not included in this repository — build your
own tooling around the steps above, matching the file formats and property
schemas documented in `docs/architecture.md`.

## 3. Auth / API configuration

The `api` service (Hono) needs these environment variables — see
`docker-compose.yml` for the full list and defaults:

- `BETTER_AUTH_SECRET` — 32+ character random secret
- `BETTER_AUTH_URL` / `BETTER_AUTH_APP_ORIGIN` — your deployed origin(s)
- `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` — optional, enables POH
  PDF auto-fill (`/api/poh-extract`); the app works without it
- `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` — optional, enables live
  ADS-B traffic overlay
- `FAA_NOTAM_CLIENT_ID` / `FAA_NOTAM_CLIENT_SECRET` — optional, enables
  worldwide NOTAM lookup via the FAA's public NOTAM Search API
  (`external-api.faa.gov`); free self-service registration at
  [api.faa.gov](https://api.faa.gov). Without it, NOTAM lookup only works
  for North American identifiers (K\*, P\*, T\*, M\*, C\*) via the
  `aviationweather.gov` fallback. FAA does not publish a documented rate
  limit for this API, so `/api/notam` self-imposes a conservative per-user
  cap (`NOTAM_HOURLY_LIMIT`, default 30/hour) to protect your shared
  credentials from being exhausted by one user — raise it if you hit false
  positives, lower it if you're worried about FAA-side throttling/bans.
  **Note:** the FAA is mid-migration to a new "NOTAM Management Service"
  (NMS, `nms.aim.faa.gov`, cut over April 2026) whose replacement API has
  no self-service signup (requires emailing FAA directly for credentials).
  The endpoint used here is a separate, still-functioning self-service
  layer with no announced retirement date, but check `apps/api/src/index.ts`
  before assuming this integration is permanent
- `BREVO_API_KEY` — optional, enables transactional email for auth OTP
  codes; without it, OTP codes are logged to the server console (fine for
  self-hosted/single-user use)

## 4. Production deployment notes

- Serve the web app's `dist/` output (or the `docker/Dockerfile` image)
  behind any static host or reverse proxy that supports HTTP Range
  requests (required for PMTiles).
- You can deploy the frontend, API, and tile storage as one origin
  (simplest) or three separate origins (see `apps/web/src/utils/env.ts`'s
  `VITE_API_BASE_URL`/`VITE_TILES_BASE_URL`) — both are supported.
- `docker/nginx.conf` is a working reference reverse-proxy config for the
  single-origin case (proxies `/api/auth`, `/rest`, `/api/weather`,
  `/api/notam` to the API service; serves `/tiles/*` and hashed JS/CSS
  assets with appropriate caching).
