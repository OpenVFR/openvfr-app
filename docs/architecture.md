# open-vfr Architecture

Deep-reference document for the project's technical design. Covers the full tech stack, map layer model, data pipeline, external sources, and phased roadmap. Intended for human contributors and as supplementary context when building features.

---

## 1. Technology Stack & Migration Path

| Domain | MVP (Current — Implemented) | Future State (Native EFB) |
| :--- | :--- | :--- |
| **Frontend Shell** | React PWA + Vite (TypeScript, CSS Modules) | React Native (Expo) |
| **Map Engine** | MapLibre GL JS + `@protomaps/basemaps` v4 | MapLibre Native |
| **Map Tile Format** | PMTiles (Cloud-Optimized, HTTP Range Requests) | PMTiles |
| **Tile Storage** | Server-side static file (nginx) / OPFS (offline) | Device File System |
| **Aviation Data** | Static GeoJSON files served by Vite / nginx | *Same* |
| **Landuse / Landcover** | PostGIS + Martin MVT tiles (`osm-landuse` vector source) | *Same* |
| **Local DB (Relational)** | RxDB via IndexedDB | AsyncStorage (RxDB-via-SQLite deferred — see `docs/native.md` §7) |
| **Backend DB** | PostgreSQL + PostGIS (docker-compose `db` service) | *Same* |
| **Backend API** | **Hono active** (POH extraction proxy on port 5200); PostgREST + better-auth deferred to Phase 6 | *Same* |
| **Data Harmonization** | *(planned Phase 4)* DuckDB (NOTAM/METAR ETL pipelines) | *Same* |
| **Tile Server** | Martin (Rust, PostGIS → MVT; `landuse_tiles` function active) | *Same* |

**Partially active:** PostgreSQL + PostGIS + Martin are running via docker-compose for the `osm-landuse` vector tile layer. All other aviation data (airspace, aerodromes, navaids, obstacles, landmarks) remains static GeoJSON for now. A **Hono API server** (`api` service, port 5200) is also active: it proxies POH PDF uploads to the Gemini File API and returns structured aircraft performance data.

**Hosting decision (supersedes the Phase 1.7 assumption below that Martin/PostGIS eventually serves *all* aviation layers):** bulk, AIRAC-cadence data (basemap, airspace, obstacles, navaids, waypoints, runways, and landuse once tiled) is pre-rendered to static PMTiles/GeoJSON and served from object storage/a CDN — zero egress cost regardless of read volume, which a live Martin/PostGIS tile server serving these same bulk layers would not have. Martin/PostGIS stays live and self-hosted **only** for genuinely dynamic data: NOTAM/METAR-TAF, temporary/live-toggled airspace activation, and user-generated content (custom minor-airport fields, noise-sensitive/DND zones, circuit patterns). See [`docs/self-hosting.md`](self-hosting.md) for how to generate and serve the static data yourself.

**Native migration path:** The React PWA is intentionally structured to allow a future move to React Native (Expo) for in-cockpit use. MapLibre GL JS → MapLibre Native, PMTiles via device filesystem, local persistence via `AsyncStorage` (same schema/key names as web's RxDB collections, round-trips through the server unchanged — RxDB-via-SQLite-adapter was investigated and deferred, see `docs/native.md` §7 for why). The aviation data format (GeoJSON) and data-prep pipeline are identical in both environments. The native app lives in `apps/native/` — see [`docs/native.md`](native.md) for full developer reference including passkey setup.

---

## 1.5 Phase 6 Backend Architecture (Planned)

User auth and cloud sync are deferred to Phase 6. The **Hono service is already running** (`api` service, port 5200) for the POH extraction proxy — Phase 6 will expand this same service rather than introduce a new container. When implemented, the full backend will be a thin layer on top of the existing PostgreSQL + PostGIS instance.

### Stack

```
PostgreSQL + PostGIS  (existing db service)
  ├── PostgREST        — auto-generated REST API over aviation/user tables
  ├── better-auth      — auth middleware (manages its own tables in same PG)
  └── Martin           — existing MVT tile server (unchanged)

Hono (TypeScript)      — thin HTTP gateway; mounts better-auth + proxies PostgREST
nginx                  — reverse proxy in front of everything
```

### Why this stack

This project uses self-hosted PostgreSQL + PostGIS (already running) with PostgREST, Hono, and better-auth added as lightweight services. Supabase is explicitly **not used** — it bundles ~8 containers (PostgREST + GoTrue + Realtime + Storage + Kong + Studio + ...) that would replace the existing `db` service and add significant operational overhead.

| Component | Why chosen |
|---|---|
| **PostgREST** | Auto-generates a REST API from PostgreSQL schema with row-level security. Zero code for CRUD on aviation/user data tables. Single stateless binary added to docker-compose. |
| **Hono** | Lightweight TypeScript web framework (~14 KB, zero deps). Mounts better-auth as middleware and adds any custom endpoints PostgREST can't express. Runs on Node.js, Bun, or any edge-worker runtime — same code. |
| **better-auth** | TypeScript auth library that lives in your codebase (not a separate service). Manages its own tables in the existing PostgreSQL instance via auto-migration. Provides `better-auth/react` hooks (`useSession`, `signIn`) that slot directly into the React PWA. Supports email/password, OAuth, magic link, passkeys, 2FA. |

### Data flow

```
React PWA
  → better-auth/react → Hono (auth endpoints)  → PostgreSQL (better-auth tables)
  → fetch/RxDB sync  → Hono → PostgREST        → PostgreSQL (user_routes, aircraft_profiles …)
  → MapLibre sources → Martin (tile endpoints) → PostgreSQL (landuse, aeroway_lines …)
```

### RxDB sync strategy

Phase 2 stores all user data in RxDB (IndexedDB) for offline-first operation. Phase 6 adds sync: RxDB's HTTP replication protocol pushes/pulls deltas to a Hono endpoint that writes to PostgREST. Auth JWT is attached to every sync request. The local RxDB schema is the source of truth; the backend is a sync target, not the primary store.

---

## 2. Map Rendering Architecture: The "Map Sandwich"

MapLibre GL JS renders all layers. Style is defined in `apps/web/src/styles/map-style.ts` (TypeScript, not a static JSON file). Layer and source IDs are declared as constants there.

**Never use Mapbox GL JS v2+, Mapbox Studio, or Mapbox APIs.** Use MapLibre GL JS exclusively.

### Source Groups (render order, bottom to top)

| # | Source ID | Type | File | Description |
|---|---|---|---|---|
| 1 | `protomaps` | vector/PMTiles | `apps/web/public/tiles/basemap.pmtiles` | OSM basemap (terrain, water, roads, cities). maxzoom=12 |
| 2 | `ofm` | GeoJSON | `apps/web/public/tiles/se-airspace.geojson` | Airspace polygons |
| 3 | `ofm-aerodromes` | GeoJSON | `apps/web/public/tiles/se-aerodromes.geojson` | 191 aerodrome/heliport points |
| 4 | `ofm-navaids` | GeoJSON | `apps/web/public/tiles/se-navaids.geojson` | 90 VOR/NDB points |
| 5 | `ofm-waypoints` | GeoJSON | `apps/web/public/tiles/se-waypoints.geojson` | 296 MRP/RP waypoints |
| 6 | `ofm-runways` | GeoJSON | `apps/web/public/tiles/se-runways.geojson` | 190 runway centrelines |
| 7 | `openaip-obstacles` | GeoJSON | `apps/web/public/tiles/se-obstacles.geojson` | 3,667 obstacle points |
| 8 | `osm-landmarks` | GeoJSON | `apps/web/public/tiles/se-landmarks.geojson` | OSM visual landmarks (churches, masts, etc.) |
| 9 | `osm-landuse` | vector/PMTiles | `apps/web/public/tiles/se-landuse.pmtiles` | OSM farmland/residential/commercial/industrial polygons, tiled with tippecanoe. Fills Protomaps landcover gap at z11–z12. |

### Airspace Layers

Layers are grouped by *kind*, not by class. Layer IDs follow `airspace-{fill,inset,border,label}-{kind}`:

| Kind | Layer suffix | Contents | Colour |
|---|---|---|---|
| CTR | `-ctr` | `type == CTR`, any ICAO class A–F | per class (`controlledStyle()`); class C CTR is magenta; fill fades out above zoom 10–12 |
| TMA / CTA | `-tma` | every other class A–F polygon (TMA, CTA, …) | A dark magenta; B/C/D blue with inset band; E same blue as a thicker line only (no band/fill); F thin lighter line; near-clear map fill |
| RMZ / ATZ / TMZ | `-g` | `type` in RMZ/ATZ/TMZ (filed under class G in the data) | thin dashed grey outline |
| Restricted | `-restricted`, `-border-danger` | class `R`, `TRA`, and danger areas (`class D` + `type D`) | red (R, danger dashed), paler orange (TRA) |
| Activity | `-activity` | GLDR, MODEL (default off) | yellow/green |

Class G (the default airspace) is never drawn. The data's class `D` mixes ICAO Class D (type CTR/TMA) with danger areas (type `D`); `airspaceDisplayClass()` in `@open-vfr/shared/airspaceColors` maps the latter to `R`. Every polygon keeps its class in its on-map boundary label (e.g. `C 1500ft MSL-FL065`, `CTR D SFC-2000ft MSL`).

Altitude filter: `AltitudeSlider` → `buildAltitudeFilter()` → `map.setFilter()` per layer. Uses `lower_ft` GeoJSON property. Default ceiling FL095 (9,500 ft). `AIRSPACE_BASE_FILTERS` constant in `map-style.ts` mirrors initial filter state — do not read filters back from the map object after `styledata`.

**`class` vs `type` distinction:** `class` = display bucket used for styling above. `type` = raw OFMX `codeType` (CTR, TMA, CTA, D, R…). Both fields are present; `AirspacePopup` uses `type` for the human-readable label and `class` for colour.

### Aerodrome Layers

- `aerodromes-icon` — MapLibre `symbol` layer. Canvas-drawn icons via `apps/web/src/utils/aerodromeIcons.ts`. AD/AH = blue circle + crosshair (`ad-airport`); HP = purple circle + H (`ad-heliport`). Icon size interpolates 0.45→0.85 across zoom.
- `aerodromes-label` — ICAO code. minzoom=8. `text-offset [0, 1.0]` clears the larger icon.
- Click popup: `AerodromePopup` via `queryRenderedFeatures` with ±10 px bbox hit detection. Shows frequencies, runways, PPR, contacts, fuel.

### Navaid Layers

- `navaids-vor-icon` + `navaids-vor-label` — MapLibre `symbol`. Canvas icon: indigo hexagon + 6 ticks + centre dot (`nav-vor`). minzoom=6/7.
- `navaids-ndb-icon` + `navaids-ndb-label` — MapLibre `symbol`. Canvas icon: orange double-circle + 4 cardinal ticks (`nav-ndb`). minzoom=6/8.

### Waypoint Layers

- `waypoints-mrp-icon` + `waypoints-mrp-label` — MapLibre `symbol`. Canvas icon: teal filled triangle (`wp-mrp`). minzoom=8/9.
- `waypoints-rp-icon` + `waypoints-rp-label` — MapLibre `symbol`. Canvas icon: lighter teal outline triangle (`wp-rp`). minzoom=9/10. Default off.

### Runway Layer

- `runways-line` — surface-colored: ASPH=grey, GRASS=green. minzoom=11, fades in at z12.

### Obstacle Layers

- `obstacles-circle` — MapLibre `symbol` layer. Canvas-drawn icons via `registerObstacleImages()` in `apps/web/src/utils/obstacleIcons.ts`. minzoom=9.
  - Icon shapes: wind turbine (3-blade rotor + mast, amber), tower (lattice triangle + antenna, red), chimney (tapering stack, dark red), building (rect outline, grey), other (warning triangle, orange).
  - Icons drawn at 2× resolution onto `HTMLCanvasElement`, registered with `map.addImage(id, imageData, { pixelRatio: 2 })` inside `styledata` handler.
- `obstacles-label` — elevation in feet with `'` suffix. minzoom=12.
- License: CC BY-NC 4.0, © openAIP. Attribution required in UI.

### Landmark Layer

- `landmarks-circle` + `landmarks-label` — OSM visual landmarks (churches, masts, windmills, water towers, chimneys). Canvas-drawn icons via `apps/web/src/utils/landmarkIcons.ts`. minzoom=12.
- Deduplicated against OpenAIP at data-prep time (masts/chimneys within 200 m of an OpenAIP tower/chimney suppressed; windmills within 300 m of a wind_turbine suppressed).

### UI Controls

| Component | Location | Purpose |
|---|---|---|
| `RegionSelector` | Floating, top-left | Country/region dropdown (37 European countries). Updates `osm-landuse` tile URL via `source.setTiles()` — no style reload. |
| `LayerPanel` | Floating, below RegionSelector | Toggle visibility per `LAYER_GROUP`. CSS `--group-color` vars. |
| `AltitudeSlider` | Floating, top-right | Airspace ceiling filter (default FL095). |
| `AerodromePopup` | Absolute-positioned | Aerodrome click detail. `--popup-x`, `--popup-y`, `--popup-translate` CSS vars. Flips above/below viewport y. |
| `AirspacePopup` | Absolute-positioned | Airspace click detail. SVG altitude diagram, gap detection, ceiling-first sort. |

### Pluggable Basemap Architecture

The map supports swappable basemaps without reloading the MapLibre instance, preserving pan/zoom/rotation.

- **Default:** Protomaps vector tiles (`pmtiles://…`). **Alternative:** satellite raster tile provider.
- **Web UI:** Vector/Satellite segmented control at the top of the side pane's Layers section (`LayerPanel.tsx`), followed by the Altitude Filter slider — no separate map button or side-pane section for either.
- **Swap mechanism:** MapLibre runtime API (`map.addSource`, `map.addLayer`, `map.removeLayer`, `map.removeSource`, layer ordering). **Never reload the full style object** — this drops aviation sources, resets all filters, and clears registered images.
- **Offline fallback:** If basemap tiles fail, aviation layers continue rendering on a blank background.
- **Dynamic contrast:** `basemapMode: 'vector' | 'satellite'` React state triggers `map.setPaintProperty()` sweep in the `useEffect` that watches `basemapMode`. Two passes:
  1. `AVIATION_LABEL_LAYERS` (exported from `map-style.ts`) — `text-halo-color: '#ffffff'` always; `text-halo-width` 1.5→2.5 px on satellite, restored to 1.5 on vector.
  2. `AIRSPACE_BORDER_WIDTHS` (exported from `map-style.ts`) — per-layer `line-width` boosted on satellite (e.g. Class C 2.0→2.5, Class E 1.5→2.0); restored to original values (including `match` expressions) on vector. Both passes use the same `isSat` flag so the switch is a single atomic effect.

### Protomaps POI Limitation

The `pois` layer in Protomaps v4 (wind turbines, churches, towers…) starts at minzoom=16. Our basemap is extracted at `--maxzoom=12`. **Point POIs do not exist in our tiles at all.** Never attempt to style Protomaps `pois` — use OpenAIP for obstacle data instead.

---

## 2.5 Production Deployment

This section covers the general-purpose deployment topology shipped in this
repository (`docker/Dockerfile`, `docker/nginx.conf`, `docker-compose.yml`).
For how to generate the map/aviation data files this topology serves, and
for an optional split-subdomain deployment (frontend/API/tiles on separate
origins), see [`docs/self-hosting.md`](self-hosting.md).

Single-origin topology (`docker/nginx.conf`):

```
Internet
  └── nginx:1.30-alpine (:80)  — single public entry point
        ├── /api/*     →  api:5200    (Hono API server — auth, POH extraction, weather/NOTAM proxy)
        ├── /rest/*    →  postgrest:3001 (user data sync)
        └── /*         →  app:80      (React SPA + PMTiles static files)

db:5432  (PostGIS — not on host port, reachable only inside Docker network)
api:5200 (Hono — not on a public host port in production; accessed via nginx)
```

### Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Service definitions for `db`, `martin`, `api`, `postgrest`, and an optional `app` (CI/Linux parity) container |
| `docker/nginx.conf` | Reverse-proxy config: security headers, CSP, Range-header passthrough for PMTiles, `/api/*`/`/rest/*` proxying |
| `docker/Dockerfile` | Two-stage build: `pnpm --filter web build`, then serves `dist/` via `nginx:1.30-alpine`. Accepts `ARG VITE_MARTIN_URL` baked into the bundle at build time |
| `docker/Dockerfile.server` | `node:24-alpine`, Corepack pnpm, installs `apps/api` deps via the root workspace, runs `tsx src/index.ts` |
| `apps/api/src/index.ts` | Hono app: `GET /health`, `POST /api/poh-extract` (Azure OpenAI proxy), better-auth handler |

### Security posture

- Secrets (`POSTGRES_PASSWORD`, `AZURE_OPENAI_API_KEY`, `BETTER_AUTH_SECRET`, etc.) are sourced from your own `.env`/environment — never hardcoded. The `api` service returns 503 for POH import if Azure OpenAI credentials are absent, so the app still runs without that feature enabled.
- **`db` and `martin` have no public `ports:` entries in a production deploy** — unreachable from the host; only your reverse proxy should expose `api`/`app`/`postgrest`.
- **`server_tokens off`** in nginx — no version disclosure in headers or error pages.
- **Security headers** set once in the `server {}` block to guarantee inheritance (adding `add_header` in any `location {}` would silently drop the parent headers): `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(self), microphone=(), camera=()` (self: Go Flying and the Passive location mode use the Geolocation API), and a `Content-Security-Policy` covering MapLibre's inline styles + PMTiles WebWorker (`blob:`) + ESRI/Protomaps CDN `connect-src`.
- **PMTiles Range passthrough:** `proxy_set_header Range`, `proxy_pass_header Content-Range/Accept-Ranges` must stay explicit wherever tiles are proxied — a naive proxy silently drops these, breaking PMTiles random-access reads.

### `VITE_MARTIN_URL` build arg

In dev, the fallback in `apps/web/src/styles/map-style.ts` defaults to `http://localhost:3000`. In a single-origin production build, pass `VITE_MARTIN_URL=/martin` as a build arg so the bundled JS hits `/martin/…`, which nginx proxies to the internal Martin container — no CORS, no exposed port.

---

## 3. Data Pipeline

### A. Basemap — Protomaps PMTiles

- **Source:** `https://build.protomaps.com/{YYYYMMDD}.pmtiles` — daily OSM planet builds.
- **Action:** `pmtiles extract` clips the Sweden bbox (10.9,55.3,24.2,69.1) at `--minzoom=7 --maxzoom=12` → `apps/web/public/tiles/basemap.pmtiles` (~637 MB), plus a separate unclipped continent-wide extract at `--maxzoom=6` → `europe-overview.pmtiles` (~10 MB, built once, shared across countries — fixes a real bug where the old single z0-12 Sweden-only archive left bare gray canvas outside its bbox at ANY zoom, which regional NOTAM markers rendered over since NOTAM fetch radius is independent of basemap coverage).
- **Serving:** MapLibre fetches only tiles needed for the current viewport via HTTP Range Requests. Full file never downloaded unless doing an offline pre-cache.
- **Why PMTiles:** Single-file archive, no tile server required. Works with HTTP Range Requests in browsers and direct file reads on native.

#### Basemap Technology Rationale

Protomaps is the correct choice for this project's constraints (open-source, no commercial APIs, offline-capable PWA). Comparison against realistic alternatives:

| Option | Offline | License | Notes |
|---|---|---|---|
| **Protomaps (current)** | ✅ Single file | ODbL | Best fit. `@protomaps/basemaps` provides a ready-made MapLibre style. |
| OpenMapTiles / MapTiler | ⚠️ Self-host only | Proprietary free tier | MapTiler API key required; self-hosting the schema is complex. |
| Versatiles (Shortbread schema) | ✅ | ODbL | Fully open spec, good tooling, but less mature ecosystem and fewer ready styles. |
| Geofabrik PBF → tippecanoe | ✅ | ODbL | Full control over zoom levels; significant data pipeline work. |
| Stadia Maps | ❌ Hosted only | Requires API key | Not offline-capable; breaks the no-commercial-API constraint. |

**Known limitation — maxzoom 12:** The basemap is currently extracted at `--maxzoom=12`. At z13+ MapLibre overzooms the vector data, so road labels and building outlines get coarser exactly when runway/taxiway detail is visible. The fix is to re-extract `basemap.pmtiles` at `--maxzoom=14` or `--maxzoom=15` from a Geofabrik Sweden PBF. This would sharpen the background context at airport zoom levels without any other code changes. Tracked as a future improvement.

### B. Airspace, Aerodromes & Navaids — OFM OFMX

- **Format:** OFMX (OpenFlightMaps eXchange), based on AIXM 4.5 XML.
- **AIXM reference:** `https://aixm.aero/sites/default/files/imce/AIXM51HTML/index.html` — core feature model (airspace, aerodrome, navaid, waypoint) is stable from 4.5 → 5.1. SWIM NOTAM feeds (Phase 4) will be AIXM 5.x and require a separate parser.
- **Download URL:** `https://snapshots.openflightmaps.org/live/{AIRAC}/ofmx/esaa/latest/ofmx_es.zip`
- **Zip contents:**
  - `ofmx_es/isolated/ofmx_es.ofmx` — metadata (class, name, altitude limits, positions)
  - `ofmx_es/isolated/ofmx_es_ofmShapeExtension.xml` — pre-computed polygon coordinates (arcs already interpolated)
- **Parser:** `scripts/ofmx_to_geojson.py` — joins both files by `mid` UUID. Args: `<ofmx> <shape> <airspace_out> <aerodromes_out> <navaids_out> <waypoints_out> <runways_out>`
- **Outputs:**
  - `se-airspace.geojson` — Polygon. Props: `{class, type, name, upper, lower, upper_ft, lower_ft}`
  - `se-aerodromes.geojson` — Point (191). Props: `{icao, name, type, elevation_ft, frequencies[], fuel[], ppr, ppr_remarks[], contacts[], runways[]}`
  - `se-navaids.geojson` — Point (90). Props: `{kind, id, name, navaid_type, freq, freq_str, has_dme, elevation_ft}`
  - `se-waypoints.geojson` — Point (296). Props: `{id, name, wp_type, aerodrome}`
  - `se-runways.geojson` — LineString (190). Props: `{icao, designator, length_m, width_m, surface, mag_brg}`
- **Note:** OFM also provides OPENAIR (airspace-only) and raster `.mbtiles`. Neither is used.

### C. Obstacles — OpenAIP Core API

- **Source:** Official OpenAIP Core API, `https://api.core.openaip.net/api/obstacles` (paginated, `country`+`page`+`limit` query params). Requires a free API key (`x-openaip-api-key` header or `apiKey` query param) — register at https://www.openaip.net (user profile → API Clients).
  - **Migration note (2026):** the old anonymous public GCS bucket (`storage.googleapis.com/29f98e10-a489-4c82-ae5e-489dbcd4912f/{iso2}_obs.geojson`) switched to "requester pays" and started returning `400 UserProjectMissing` for anonymous downloads — no longer usable. Migrated to the documented REST API instead.
  - Sweden: ~3,667 features, paginated 1,000/page (4 pages).
- **License:** CC BY-NC 4.0, © openAIP. Attribution required in UI. Non-commercial use only.
- **Parsers:** obstacles are converted to static per-country GeoJSON (retired from PostGIS/Martin) — see `docs/self-hosting.md`.
- **Output:** `se-obstacles.geojson` — Point. Props: `{kind, name, elevation_m, height_m, elevation_ft}`
  - `kind` values: `wind_turbine` (2,500), `tower` (130), `building` (21), `chimney` (8), `other` (1,008)
  - `elevation_m` = AMSL; `height_m` = AGL (0 if unknown); `elevation_ft` = derived
  - OpenAIP type codes per the official API schema (differs from the old GCS bucket's numbering): 0=Obstacle (generic, inspect `osmTags`), 1=Chimney, 2=Building, 3=WindTurbine, 4=Tower

### D. OSM Landuse Polygons — static PMTiles (retired from PostGIS/Martin)

- **Source:** local `.osm.pbf` extract (Geofabrik primary, `download.openstreetmap.fr` fallback — `scripts/download_osm_pbf.sh`), filtered via `osmium-tool`. ODbL. Migrated off both PostGIS/Martin *and* live Overpass (see `scripts/osm_landuse_to_geojson.py` header) after Overpass banded queries started hitting repeated HTTP 504s under load.
- **Kinds:** `farmland` (farmland/meadow/orchard), `residential`, `commercial` (commercial/retail), `industrial`, `wetland`.
- **Why a separate layer at all, not just a sharper basemap:** Protomaps' `landcover` fill fades to 0 opacity by z10 (tuned for country/region overview, not close-in flight planning), and `basemap.pmtiles` itself is capped at `--maxzoom=12` (see the maxzoom-12 known limitation above) with no finer farmland/urban replacement layer in the Protomaps LIGHT theme at any zoom. Together this leaves a flat void at z10+ exactly where VFR planning/flying needs ground-reference detail. This layer fills that gap with explicit, ICAO-coloured OSM polygons rendered at every zoom.
- **Why a separate pipeline instead of just raising `basemap.pmtiles`'s maxzoom to 14/15 (the fix already tracked for the maxzoom-12 limitation above):** file size. `basemap.pmtiles` is 663 MB at maxzoom=12 covering *every* Protomaps layer (roads, buildings, water, admin, POIs, labels). Re-extracting the whole archive 2–3 zoom levels deeper to fix one narrow landuse gap would inflate that all-purpose file well past 1 GB — a cost paid by every user's download and offline cache, for detail we don't actually need sharper in most of those other layers. The dedicated osmium→tippecanoe pipeline instead targets only the 5 landuse kinds above: shipped `se-landuse.pmtiles` is **56.87 MB** (all zooms, tippecanoe-simplified) vs. the 400 MB raw pre-tippecanoe GeoJSON it's built from — roughly 10x+ smaller than the basemap-maxzoom-bump alternative for equivalent practical benefit. Revisit this decision if the maxzoom-12 basemap re-extract ever happens for other reasons (runway/taxiway sharpness) — it may then be cheaper to retire this layer and fold landuse into that rebuild.
- **Filter correctness — `wr/`, not `w/`:** `osmium tags-filter` must match both ways AND multipolygon relations (`wr/{tag}`, not `w/{tag}` alone). Large/complex farmland or urban areas are frequently mapped as multipolygon relations with `inner` member ways as holes (e.g. a real forest patch carved out of a farmland boundary). A ways-only filter drops that hole geometry: if the relation's outer way is *also* individually tagged (common duplicate tagging in OSM), tags-filter still matches it standalone, and `osmium export` then renders it as a plain closed-way polygon with no awareness of the relation's inner ring — painting a solid farmland/residential polygon straight over what should have been an excluded (e.g. forested) hole. Same fix applies to `scripts/osm_water_to_geojson.py`.
- **Loader:** `scripts/osm_landuse_to_geojson.py <country_code> <input_pbf> <output_geojson>` — `osmium tags-filter` + `osmium export`, stdlib only, no pip.
- **Cron refresh:** `scripts/cron_landuse.py`, monthly, staggered with `cron_water.py` — reuses the shared per-country `.osm.pbf` download (`scripts/download_osm_pbf.sh`) also used by the water script.
- **Tiling:** `se-landuse.geojson` → `se-landuse.pmtiles` via tippecanoe. Served as a static `pmtiles://` source from object storage, same pattern as `basemap.pmtiles` — zero egress cost, no Martin/PostGIS involved.
- **MapLibre source:** `osm-landuse` — `type:'vector'`, `pmtiles://` URL built by `getLanduseSource(region)` in `map-style.ts`. `source-layer:'landuse'`.
- **Region switching:** PMTiles url-based sources have no `setTiles()`. `RegionSelector`/region-change effect in `MapView.tsx` does `removeLayer`/`removeSource`/`addSource`/`addLayer` (same pattern as `osm-hillshade`'s region swap) — never a full style reload.
- **Colour palette:** ICAO chart convention, patched to match Protomaps' `landcover.farmland` override for a seamless z10→z11 handoff — farmland cream `rgba(242,237,200,1)`, residential `rgba(230,230,230,1)`, commercial `rgba(222,220,230,1)`, industrial `rgba(209,221,225,1)`, wetland `rgba(188,220,235,1)`.

### E. OSM Visual Landmarks — Overpass API

- **Source:** `https://overpass-api.de/api/interpreter` (HTTP POST). ODbL.
- **Parser:** `scripts/osm_landmarks_to_geojson.py` — queries churches, masts, windmills, water towers, chimneys within the Sweden bbox.
- **Deduplication:** masts/chimneys within 200 m of an OpenAIP tower/chimney suppressed; windmills within 300 m of a wind_turbine suppressed.
- **Phase 1.7 plan:** Replace Overpass with Geofabrik daily `.osm.pbf` extract filtered by `osmium` (purpose-built C++ PBF streaming; faster than DuckDB for this task), load into PostGIS `landmarks` table with `country` column, serve via Martin.

### F. Dynamic Data — DuckDB (Phase 4, not yet implemented)

NOTAMs and METAR/TAF will be processed by DuckDB pipelines: download raw JSON from NOAA/Eurocontrol, spatial-join against the aerodromes table in PostGIS, export as clean GeoJSON or serve via Martin. DuckDB is the right tool here because these are tabular/JSON sources that benefit from SQL aggregation and columnar filtering. DuckDB is **not** used for OSM PBF processing — `osmium` is faster for that specific task.

**METAR/TAF parsing:** Raw text from NOAA Aviation Weather Center (public domain, no API key) will be decoded by a TypeScript METAR/TAF library (candidate: `metar-taf-parser`, MIT).

**Privacy proxy:** All METAR/TAF and NOTAM fetches will be routed through the Hono API server (`/api/weather`, `/api/notam`) — not directly from the browser. This hides the user's IP from NOAA and Eurocontrol, consistent with the existing POH extraction proxy. The Hono server can also cache responses to reduce repeated calls.

---

## 4. data-prep Docker Container

File: `docker/Dockerfile.data-prep`

- Base: Alpine Linux 3.19, Python 3.11
- Python packages installed via `apk` (system packages, no pip): `py3-psycopg2`, `py3-lxml`, `py3-shapely` — see package table below
- Available tools: `pmtiles` CLI v1.30.1, `curl`, `bash`, `unzip`, `node`, `psql` (postgresql-client)
- Planned addition (Phase 1.7): `osmium-tool` for Geofabrik PBF tag filtering
- Volumes: `./data:/workspace/data`, `./public/tiles:/workspace/public/tiles`, `./scripts:/workspace/scripts`
- Environment: `DATABASE_URL` injected from docker-compose — allows `load_region.sh` to connect to the `db` service

```sh
# Run one-off command
docker compose --profile tools run --rm --entrypoint "" data-prep sh -c "..."

# Run prepare-tiles (strips Windows CRLF)
docker compose --profile tools run --rm --entrypoint "" data-prep sh -c "tr -d '\r' < scripts/prepare-tiles.sh | bash"

# Load a region into PostGIS (db + martin must be running: docker compose up -d db martin)
docker compose --profile tools run --rm data-prep bash scripts/load_region.sh se 55.3,10.9,69.1,24.2
```

### Packages installed (Alpine apk, no pip)

| Package | Version | Used by |
|---|---|---|
| `py3-psycopg2` | 2.9.9 | `db_atomic_load.py` — transactional COPY |
| `py3-lxml` | 4.9.3 | Future OFMX parser refactor |
| `py3-shapely` | 2.0.2 | Future geometry operations refactor |

---

## 4.5 Data Refresh Jobs

All data updates run inside the `data-prep` container against the PostGIS `db` service.  
`db_atomic_load.py` wraps every load in a single PostgreSQL transaction (DELETE + COPY + metadata upsert), so the web app and Martin tile server always see either the old data or the new data — never an empty table.  
Load metadata (row count, timestamp, AIRAC cycle) is recorded in the `data_loads` table on every successful commit.

### Data refresh automation

The refresh lifecycle (fetching source data, converting to GeoJSON/PMTiles,
recording load metadata, writing `manifest.json`) is not part of this
repository's automation — see [`docs/self-hosting.md`](self-hosting.md) for
the pipeline shape and build your own scheduling around it (cron, CI, a
scheduled cloud job, or just running it manually per AIRAC cycle).

### Manifest format (`apps/web/public/tiles/manifest.json`)

Written atomically by `write_manifest.py` after every cron run (write to `.tmp`, then `os.replace`). The PWA reads this on startup to detect data updates.

```json
{
  "generated_at": "2026-04-28T10:00:00+00:00",
  "countries": {
    "se": {
      "airspace":   { "airac_cycle": "2604", "loaded_at": "2026-04-12T08:23:11+00:00", "row_count": 456 },
      "aerodromes": { "airac_cycle": "2604", "loaded_at": "2026-04-12T08:23:15+00:00", "row_count": 191 },
      "obstacles":  { "loaded_at": "2026-04-25T03:11:42+00:00", "row_count": 3667 },
      "landuse":    { "loaded_at": "2026-04-01T02:00:00+00:00", "row_count": 12345 }
    }
  }
}
```

### Frontend data-update detection (`useDataManifest`)

`apps/web/src/hooks/useDataManifest.ts` fetches `/tiles/manifest.json` with `cache: 'no-cache'` on every app mount. It compares `manifest.generated_at` against `localStorage` key `ovfr:manifest:seen_at`:

- **`hasUpdate = true`** → MapView shows a dismissable centre-top banner: *"Aviation data updated — reload to apply"* with a **Reload** button (`window.location.reload()`) and **✕** dismiss (`markSeen()` stores `generated_at` in localStorage).
- **`hasUpdate = false`** on 404 or network error — app continues normally (handles dev without PostGIS gracefully).
- The **Settings panel** always shows a *Data versions* section listing each country's AIRAC cycle and last-updated date when a manifest is available.

### Determining if data is stale (manual query)

```sql
SELECT dataset, country, airac_cycle, loaded_at, row_count
FROM   data_loads
ORDER  BY dataset, country;
```

OFM data is stale when `airac_cycle` doesn't match the current AIRAC (new cycle every 28 days, anchored to 2003-01-23).

---

## 5. External Data Sources

### Currently Integrated

| Source | Provides | URL / Access | License | Update cadence | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Protomaps** | OSM basemap vector tiles | `https://build.protomaps.com/{YYYYMMDD}.pmtiles` | ODbL | Daily | maxzoom=12, Sweden bbox. No POIs at our zoom level. |
| **OpenFlightMaps (OFM)** | Airspace, aerodromes, navaids, waypoints, runways | `https://snapshots.openflightmaps.org/live/{AIRAC}/ofmx/esaa/latest/ofmx_es.zip` | ODbL | Every 28-day AIRAC cycle | OFMX format (AIXM 4.5 XML). |
| **OpenAIP** | Obstacles (turbines, towers, chimneys) | `https://api.core.openaip.net/api/obstacles?country={ISO2}` (paginated) | CC BY-NC 4.0 | Weekly | Official Core API, requires free API key (`OPENAIP_API_KEY`, register at openaip.net → profile → API Clients). **Attribution required.** Non-commercial only. Old anonymous GCS bucket export retired (requester-pays now). |
| **OpenStreetMap** (Overpass) | VFR ground landmarks | `https://overpass-api.de/api/interpreter` | ODbL | On-demand | Sweden bbox hardcoded for now. Phase 1.7: replace with Geofabrik PBF + osmium. |
| **OpenStreetMap** (Overpass) | Landuse polygons | `https://overpass-api.de/api/interpreter` | ODbL | Monthly per country | Per-country via `load_region.sh`. Stored in PostGIS `landuse` table, served via Martin. Phase 1.7: replace with Geofabrik PBF. |

### Planned / Evaluated

| Source | Provides | URL / Access | License | Status | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Geofabrik** | Country `.osm.pbf` extracts | `https://download.geofabrik.de/<region>/<country>-latest.osm.pbf` | ODbL | Phase 1.7 | Daily builds. Replaces Overpass for landmarks + landuse. No rate limits. |
| **OFM (multi-region)** | Airspace/aerodromes/navaids for all European FIRs | `https://snapshots.openflightmaps.org/live/{AIRAC}/ofmx/<fir>/latest/ofmx_<cc>.zip` | ODbL | Phase 1.7 | 28-day AIRAC cadence. Retired from Postgres/Martin — converted to static per-country GeoJSON, served from object storage. |

| Source | Provides | URL / Access | License | Status | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Eurocontrol B2B / SWIM** | NOTAMs, AUP/UUP | Eurocontrol NM B2B API | Restricted | Phase 4 | Requires org-level access. AIXM 5.x format — needs separate parser. Eurocontrol's public GitHub repos contain only analytics packages, no operational data. |
| **NOAA Aviation Weather** | METAR, TAF, AIRMETs | `https://aviationweather.gov/api/data/` | Public domain | Phase 4 | REST API, no key required. Worldwide coverage. |
| **Eurocontrol NOTAM** | European NOTAMs | Eurocontrol NM B2B | Restricted | Phase 4 | May be replaceable with national AIP NOTAM feeds (Sweden: LFV). |
| **LFV (Luftfartsverket)** | Sweden AIP, NOTAMs | `https://aro.lfv.se/` | AIP copyright | Phase 4 | Swedish ANSP. AIP accessible via OFM for charting. |
| **OpenSky Network** | Live ADS-B/FLARM traffic | `https://opensky-network.org/api/states/all?lamin=…` | Non-commercial | Phase 3 | OAuth2, free account. 4,000 credits/day; Sweden bbox ≈ 3 credits/call ≈ 1,333 calls/day. 5 s resolution. |
| **OpenAeroVFR** | European VFR charts (raster) | `https://www.openaeromap.org` | CC BY-SA | Evaluated, not used | Raster PNG tiles — not compatible with our vector stack. |
| **OurAirports** | Global airport database (CSV) | `https://ourairports.com/data/` | Public domain | Evaluated, not used | Good fallback but OFM OFMX is richer for European data. |
| **OpenAIR** | User-imported supplemental airspace | User-supplied `.txt` file | Various (per file) | Phase 2 | Parachute drop zones, microlight sites, glider club areas, temporary restrictions not in OFM. Client-side parser → GeoJSON overlay. No server needed. |

---

## 6. Considered & Deferred Tools

| Tool | Status | Notes |
|---|---|---|
| **Martin** (Rust tile server) | Available, currently no live function sources | Serves PostGIS polygons as per-viewport MVT. `docker/martin.yaml` + `martin` service in docker-compose. **Scope:** limited to genuinely dynamic layers (NOTAM/METAR-TAF, live airspace activation, user-generated content) — bulk OFM aviation data (airspace, aerodromes, navaids, obstacles, landuse) is served as static PMTiles/GeoJSON from object storage instead. |
| **PostGIS** | ✅ Active — `landuse` table + GIST indexes + MVT function | Schema lives in `db/migrations/` (dbmate) applied via `scripts/migrate.sh up`; run once after `docker compose up -d db` and after pulling any new migration. Future additions are the small dynamic/user-generated tables above, not the full bulk OFM dataset. |
| **DuckDB spatial** | Planned Phase 4 | Batch ETL for NOTAM JSON + METAR/TAF from NOAA API. Tabular/JSON sources that benefit from SQL aggregation. **Not** used for OSM PBF (osmium is faster for that). |
| **osmium-tool** | Planned Phase 1.7 | Fast C++ PBF streaming tool for filtering Geofabrik extracts by tag. Replaces Overpass for landmarks + landuse once added to data-prep container. |
| **MapLibre Tile Specification (MLT)** | Deferred | Next-gen MVT replacement. Experimental; no Protomaps support, no stable MapLibre GL JS rendering. Ignore until ecosystem matures (~2–3 years). |
| **Charites** (unvt/charites) | ❌ Not applicable | YAML-based MapLibre style authoring tool: write styles as split YAML files with variables, compile to `style.json`. Does not fit open-vfr because: (1) our style is built **programmatically in TypeScript** (`map-style.ts`) with runtime logic — altitude filters, `getLanduseUrl()`, layer interleaving via `findIndex` — none of which can be expressed in static YAML; (2) the **"never reload the full style object"** constraint means basemap swaps and layer updates must go through the MapLibre runtime API (`addSource`, `setTiles`, `setLayoutProperty`), not a compiled JSON replacement; (3) adopting Charites would require rewriting `map-style.ts` into static YAML and losing all computed logic, which is a regression. |
| **metar-taf-parser** (npm, TypeScript) | Evaluate for Phase 4 | MIT-licensed TypeScript library for decoding METAR/TAF text into structured objects (wind, visibility, temperature, QNH, cloud layers, weather phenomena). Preferred over hand-rolled regex. |
| **OpenAIR parser** | Implement for Phase 2 | Text format for airspace definitions (`.txt`). A client-side TypeScript parser converts OpenAIR files to GeoJSON matching the same `{class, upper_ft, lower_ft, name}` schema as OFM data. No server required — parse in browser on file drop. |
| **MapProxy** (`mapproxy.org`) | ❌ Not applicable | Python/WSGI WMS/WMTS/TMS caching + reprojection proxy — fetches from raster tile/WMS sources, re-tiles, caches to disk. Solves a problem we don't have: basemap + aviation vector layers are static PMTiles (single-file, HTTP Range) with no tile server, and Phase 4 dynamic layers are already covered by Martin (MVT from PostGIS). Only a future fit if we add a raster overlay from an open-licensed external WMS source (e.g. weather radar, NOTAM graphics) needing caching/reprojection to EPSG:3857 — niche, not core stack. |

---

## 7. Aviation UX Conventions

Design patterns specific to aviation UI that must be consistent across the app.

### METAR Flight Category Colours

Used wherever a METAR-derived condition is displayed: aerodrome popup header strip, METAR dot on map, weather station list.

| Category | Token | Hex | Condition |
|---|---|---|---|
| **VFR** | `--status-vfr` | `#2d8a4e` (green) | Ceiling ≥ 3,000 ft **and** vis ≥ 5 nm |
| **MVFR** | `--status-mvfr` | `#2563a8` (blue) | Ceiling 1,000–3,000 ft **or** vis 3–5 nm |
| **LIFR / IFR** | `--status-ifr` | `#c0392b` (red) | Ceiling < 1,000 ft **or** vis < 3 nm |
| **Unknown / stale** | `--status-wx-unknown` | `#7f3d8b` (magenta) | No data or data > 2 h old |

These four tokens must be added to `apps/web/src/styles/theme.css` when Phase 4 weather is implemented. **Never hard-code hex values in component CSS** — always reference the token.

### Airspace Ceiling Auto-Escalation

The `AltitudeSlider` enforces a pilot-set ceiling. When the aircraft's GPS altitude climbs within 500 ft of the ceiling, the ceiling must be automatically raised by 2,000 ft (with a toast notification) to prevent inadvertently hiding the airspace being entered. Implemented in `useGoFlying.ts` / `useAirspaceWarnings.ts` when Phase 3 is active.

### NOTAM Acknowledgement Model

Pilots should never lose track of which NOTAMs they've reviewed:
- Tapping a NOTAM dims it (opacity 0.5) — **session-only**, resets on each new planning session
- A brief non-blocking toast confirms: "Marked as Read"
- Dimmed NOTAMs remain visible (not hidden) so the full picture is preserved
- An "expand abbreviations" toggle decodes ICAO shorthand inline (stored in RxDB settings)
- A stale-data banner appears if NOTAM cache is > 1 h old

### Wind Correction Angle (WCA)

Each route leg must show the WCA alongside the magnetic heading (e.g. `093°M / WCA +3°`). This is the heading the pilot actually flies — not the track. Computed from `(wind vector × TAS) → ground vector` using the standard wind triangle. When global wind is zero, WCA = 0 and can be omitted from display.

### Sunrise / Sunset Awareness

Displayed in the aerodrome popup for destination/alternate aerodromes. Use an astronomical formula (no external API) — e.g. the `suncalc` npm package (BSD-2). Highlight ETAs within ±30 min of civil sunset in amber: European VFR at night requires either a night rating or the flight to end before sunset + 30 min.

---

## 8. Phased Roadmap Summary

The detailed task list with priority and complexity annotations lives in [`docs/todo.md`](todo.md). This is a high-level phase summary only.

| Phase | Name | Status |
|---|---|---|
| 1 | Map Sandwich MVP | ✅ Complete |
| 1.5 | Aerodrome & Navaid Canvas Icons | ✅ Complete |
| 1.6 | Pluggable Basemap & Satellite Mode | ✅ Complete |
| 1.7 | PostGIS + Martin Backend (Landuse, Dynamic Data & Multi-Region Foundation) | 🔄 In progress — scope revised to dynamic layers only (NOTAM/METAR-TAF, live airspace activation, user-generated content) — bulk OFM aviation data goes to static PMTiles/object storage instead (see `docs/self-hosting.md`) |
| 2 | Flight Planning (routes, waypoints, PLOG) | 🔄 In progress — route creation, editing, PLOG, persistence, export done; map ruler, custom waypoints remaining |
| 2.3 | Aircraft Profiles & Weight and Balance | 🔄 In progress — profiles, climb/descent model, POH AI import done; W&B, checklists, cruise profiles remaining |
| 2.5 | Virtual Radar (Side-Profile Elevation View) | 🔄 In progress — terrain profile, chart, airspace overlay done; chart zoom/pan, map crosshair sync remaining |
| 3 | GPS & Real-Time Navigation | ⬜ Not started |
| 3.5 | Traffic Awareness (ADS-B, FLARM, OpenSky) | ⬜ Not started |
| 4 | Dynamic Aviation Data (NOTAM, METAR, DuckDB pipelines) | ⬜ Not started |
| 5 | Post-Flight, Logbook & Export | ⬜ Not started |
| 5.5 | Airfield Plates & Documents | ⬜ Not started |
| 6 | Cloud Sync & Cross-Device | ⬜ Not started |
