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
| `basemap.pmtiles` | PMTiles | OSM-derived vector basemap, country-bbox detail only (z7-12) |
| `europe-overview.pmtiles` | PMTiles | Shared low-zoom (z0-6) continent-wide overview, NOT country-specific -- built once, fills the gap outside `basemap.pmtiles`'s bbox so pan/zoom-out doesn't show bare gray past the detail archive's edge |
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

The `api` service (Hono) needs these environment variables — copy the
root `.env.example` to `.env` (and `apps/native/.env.example` /
`apps/web/.env.example` for the clients) and fill in; see
`docker-compose.yml` for the full list and defaults:

- `BETTER_AUTH_SECRET` — 32+ character random secret
- `BETTER_AUTH_URL` / `BETTER_AUTH_APP_ORIGIN` — your deployed origin(s)
- `APP_MIN_VERSION` — optional, defaults to `0.0.0` (always satisfied, i.e.
  a no-op). Backs `GET /api/version`, which the native app's force-update
  gate (`apps/native/src/hooks/useForceUpdate.ts`) checks on every launch.
  Bump this in the same deploy that ships a backend change old app
  binaries can no longer talk to; the app then triggers a *blocking*
  platform update flow (Play Core immediate update on Android, a
  non-cancellable App Store alert on iOS) rather than a custom modal —
  both platforms have their own accepted mechanism for this.
- `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` — optional, enables POH
  PDF auto-fill (`/api/poh-extract`); the app works without it
- `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` — optional, enables live
  ADS-B traffic overlay
- `NMS_CLIENT_ID` / `NMS_CLIENT_SECRET` — optional, enables NOTAM lookup
  via the FAA's NOTAM Management Service (NMS-API). **No self-service
  signup** — request credentials by emailing 7-AWA-NAIMES@faa.gov or
  calling 866-466-1336; you'll first get staging (`api-staging.cgifederal-aim.com`)
  credentials to validate, then must separately request production
  onboarding once staging testing passes. Without these vars set, NOTAM
  lookup is disabled entirely (`/api/notam` returns an empty list).
  Optional overrides `NMS_AUTH_HOST` / `NMS_API_HOST` default to the
  staging hosts — set both to the `api-nms.aim.faa.gov` production hosts
  once your production onboarding is approved (see `apps/api/src/notam.ts`
  header for exact URLs). NMS-API enforces a strict **account-wide**
  production rate limit (1 delta pull / 3 min, 1 full pull / 24h) —
  `notam.ts` runs a single shared background poller (not a call per user
  request) specifically to respect this; do not add per-request calls to
  NMS-API elsewhere.
- `BREVO_API_KEY` — optional, enables transactional email for auth OTP
  codes; without it, OTP codes are logged to the server console (fine for
  self-hosted/single-user use)

### Admin UI

The web admin UI at `/admin` (user list, sign-up/activity stats, banning)
and `/api/admin/*` are available to users whose `ba_user.role` is `admin`.
There is no signup path for it -- grant it by hand, after that person has
signed in once:

```sql
UPDATE ba_user SET role = 'admin' WHERE email = 'you@example.org';
```

Admins see account metadata and aggregate counts only -- never routes,
positions or flight logs. Banning uses better-auth's admin plugin: it
revokes the user's sessions and blocks sign-in while `banned` is set
(optional expiry). A ban is stored on the user row, so deleting the account
removes it. An already-issued PostgREST JWT stays valid until its 1 h expiry.

## 4. Production deployment notes

- Serve the web app's `dist/` output (or the `docker/Dockerfile` image)
  behind any static host or reverse proxy that supports HTTP Range
  requests (required for PMTiles).
- **The tile host must honour HTTP Range on `.pmtiles` on every request,
  answering `206 Partial Content` with exactly the bytes asked for.** A
  PMTiles archive is one large file that clients read in small slices
  (typically 16-64 KB per tile); if the host ever answers a Range request
  with `200 OK` and the whole file, every map tile fetch downloads the
  entire archive -- several hundred MB -- and the native app's HTTP layer
  buffers it into memory, crashing with `OutOfMemoryError`. This has
  been observed happening *intermittently* on a large multipart-uploaded
  object fronted by a CDN whose per-object cache limit was smaller than
  the archive (every request went to origin uncached). Verify with:
  `curl -sI -H 'Range: bytes=100000000-100016383' https://<tiles>/basemap.pmtiles`
  -- expect `HTTP/1.1 206` and `Content-Length: 16384`, never `200`. Repeat
  a few times; a single `200` is a failure. Object-storage backends and
  CDNs generally honour Range, but check yours, and keep single archives
  under your CDN's per-object cache limit where possible so they can be
  served from cache at all. The native app also guards against this
  (`apps/native/plugins/withMapLibreHttpGuard.js` refuses non-206 answers
  to Range requests), but that only turns a crash into a missing tile.
- **Cloudflare (R2 behind a custom domain):** the CDN cache cannot store
  objects over 512 MB on the Free, Pro and Business plans (Enterprise:
  5 GB by default). If a cache rule marks such an archive as cache-eligible
  (for example "eligible for cache" on the whole hostname), Cloudflare may
  intermittently ignore `Range` and stream the entire object. Add a Cache
  Rule placed *after* any broader cache rule (later rules override earlier
  ones) that matches `ends_with(http.request.uri.path, ".pmtiles")` on the
  tile hostname with **Cache eligibility: Bypass cache**. Requests then go
  straight to R2, which serves correct `206` responses for any archive
  size, so no per-file size list needs maintaining. Confirm with
  `curl -sI https://<tiles>/basemap.pmtiles | grep -i cf-cache-status`
  (expect `BYPASS` or `DYNAMIC`, not `HIT`/`MISS`) and repeat the Range
  check above several hundred times, since the failure is intermittent.
- You can deploy the frontend, API, and tile storage as one origin
  (simplest) or three separate origins (see `apps/web/src/utils/env.ts`'s
  `VITE_API_BASE_URL`/`VITE_TILES_BASE_URL`) — both are supported.
- To show Privacy / Terms links on the sign-in screen, set
  `VITE_SITE_BASE_URL` (web) and `EXPO_PUBLIC_SITE_BASE` (native) to the
  origin of a site serving `/privacy` and `/terms`. Unset hides the links.
- `docker/nginx.conf` is a working reference reverse-proxy config for the
  single-origin case (proxies `/api/auth`, `/rest`, `/api/weather`,
  `/api/notam` to the API service; serves `/tiles/*` and hashed JS/CSS
  assets with appropriate caching).
