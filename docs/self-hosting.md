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
docker compose up -d db api postgrest
pnpm dev
```

See the root [README.md](../README.md) and [`apps/native/README.md`](../apps/native/README.md)
for web/native dev details, and `docker-compose.yml` for the full service
list (PostGIS, Hono API, PostgREST).

## 2. Generate the map/aviation data

The app expects the following files in `apps/web/public/tiles/` (web) —
native reads the same files over HTTP from wherever you serve them (see
`apps/native/src/config.ts`'s `TILE_BASE`):

| File | Format | Contents |
|---|---|---|
| `se-basemap.pmtiles` | PMTiles | OSM-derived vector basemap, country-bbox detail only (z7-12) |
| `europe-overview.pmtiles` | PMTiles | Shared low-zoom (z0-6) continent-wide overview, NOT country-specific -- built once, fills the gap outside the country basemap's bbox so pan/zoom-out doesn't show bare gray past the detail archive's edge |
| `se-airspace.geojson` | GeoJSON | Airspace polygons (class, type, altitudes) |
| `se-aerodromes.geojson` | GeoJSON | Aerodrome points + runway/frequency data |
| `se-navaids.geojson` | GeoJSON | VOR/NDB points |
| `se-waypoints.geojson` | GeoJSON | Named VFR reporting/mandatory points |
| `se-runways.geojson` | GeoJSON | Runway centerlines |
| `se-obstacles.geojson` | GeoJSON | Obstacle points (towers, turbines, etc.) |
| `se-landmarks.geojson` | GeoJSON | Visual landmarks (churches, masts, water towers) |
| `se-aeroways.geojson` | GeoJSON | Taxiways/aprons/unlabelled runways |
| `se-water.geojson` | GeoJSON | Water polygons (kept for older app versions' offline download; the apps and the API no longer read it) |
| `se-lakes.geojson` | GeoJSON | Large lakes (surface 10 km² or more), simplified polygons taken from the water polygons; the glide check ("can I land on water") reads this file. Without it, the glide check covers the sea only and the briefing says so |
| `se-landuse.pmtiles` | PMTiles | Landuse polygons (farmland/residential/etc.), tiled |
| `se-hillshade.pmtiles` | PMTiles (raster-dem, Terrarium encoding) | Relief shading |
| `se-contours.pmtiles` | PMTiles (vector) | Elevation isolines |
| `manifest.json` | JSON | Content hashes per file, for cache-busting (see `packages/shared/src/tileManifest.ts`) |

Every file except `europe-overview.pmtiles` and `manifest.json` is per country
(`se-*` = Sweden, `no-*` = Norway, ...). The apps load the files of the
**active country** chosen in Settings (one at a time; see below); see
`apps/web/src/styles/map-style.ts` / `@open-vfr/shared/countryData` for the
wiring and `docs/architecture.md`'s data table for the property schema each
file needs.

### Countries served (`countries` table)

Which countries the apps offer is decided by the `countries` table
(migration `20261001000000_countries.sql`), not by the apps. `GET
/api/countries` lists a country only when it is `enabled` **and**
`tiles_ready_at` is set; the web/native country pickers in Settings are
built from that list. The migration seeds Sweden as enabled and ready.
Only countries openflightmaps publishes aviation data for can be served
(`SUPPORTED_REGION_CODES` in `packages/shared/src/regions.ts`: se fi dk nl
be de pl fr it at ch cz sk hu si hr ro bg gr mt); the admin API refuses the
rest and `/api/countries` never lists them.

- **Enable/disable:** the admin UI's Countries section
  (`POST /api/admin/countries/:code { "enabled": true }`)
  (admin API below), or by hand:
  `UPDATE countries SET enabled = true, enabled_at = now() WHERE code = 'no';`
  (insert the row first if it doesn't exist).
- **Mark data ready:** your data pipeline sets `tiles_ready_at = now()` (and
  clears `last_error`) once every file for that country is generated and
  served. Until then the country stays hidden from clients, so nobody can pick
  a country whose files don't exist.

### Pipeline runs (`pipeline_jobs` table, optional)

The admin UI's country detail shows each dataset's last load (`data_loads`:
AIRAC cycle, time, row count), the files the tile host serves, and the
pipeline's run history, and can request a run. Both are a contract with your
data pipeline via the `pipeline_jobs` table (migration
`20261011000000_pipeline_jobs.sql`); a pipeline that ignores it still works,
the UI then just has no history and requested runs stay queued.

- **History:** when a scheduled job starts on a country, insert a row with
  `status = 'running'`, `trigger = 'schedule'`, `started_at = now()`; when it
  ends, set `status` to `ok`/`failed`, `finished_at`, a one-line `message`
  and optionally the last few KB of output in `log_tail`. Failures are the
  point: `data_loads` only records successes.
- **Requested runs:** `POST /api/admin/countries/:code/jobs { "job": "ofmx" }`
  inserts a `queued` row. Poll for queued rows, set them `running`, run the
  job for that country, finish them as above. Job ids (see
  `apps/api/src/pipeline.ts`): `ofmx` (airspace, aerodromes, navaids,
  waypoints, runways, runway thresholds), `obstacles`, `landmarks`, `water`
  (also rebuilds the lakes file), `aeroways`, `landuse`, `basemap` (refreshes of a ready country) and `build`
  (first build of an enabled country without data).
- At most one `queued`/`running` row per (job, country) is allowed (unique
  index): a scheduled run that cannot insert its row should skip that
  country, since another run is already active.
- Set `TILES_BASE_URL` on the api (your public tile host) for the file check:
  it reads `manifest.json` and sends one `HEAD` per country file (size,
  `Last-Modified`).

NOTAMs need no per-country setup: the api keeps NOTAMs for every country in
`packages/shared/src/regions.ts` and filters per request.

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
   `osmium export` for the relevant tags, convert to GeoJSON. **Lakes**:
   from the water polygons keep the lakes of 10 km² or more, simplify the
   outlines, and write `<cc>-lakes.geojson` (a GeoJSON FeatureCollection of
   Polygon / MultiPolygon features; write it to a temporary name and rename
   it, so a half-written file is never served).
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

- `BETTER_AUTH_SECRET` — 32+ character random secret. It also signs the
  PostgREST JWTs, so it guards all user data. The api refuses to start with
  the public `docker-compose.yml` dev default when `BETTER_AUTH_URL` is
  `https://`.
- `OTP_SENDS_PER_IP_DAILY` / `OTP_SENDS_PER_EMAIL_DAILY` — optional, daily
  caps on sign-in code emails per client IP (default 30) and per address
  (default 10), on top of better-auth's 3/min per IP. Fixed-code test /
  review accounts are exempt.
- `WX_HOURLY_LIMIT` / `WX_DAILY_LIMIT` — optional, per-user caps on
  `/api/weather` cache misses (default 600 / 3000).
- `BRIEFING_HOURLY_LIMIT` / `BRIEFING_DAILY_LIMIT` — optional, per-user
  caps on route briefings (`POST /api/briefing`, default 30 / 150). A
  briefing's weather lookups also count against the weather caps.
- `POSTGREST_INTERNAL_URL` — optional, the api's own address for PostgREST
  (e.g. `http://postgrest:3001` in the compose file). Route briefings read
  the user's saved routes and aircraft through it with a short-lived token
  for that user, so row-level security applies; the api's database role
  keeps no access to user tables. Unset = briefings work only for routes
  sent in the request.
- `APPLE_TEAM_ID`, `ANDROID_SHA256_FINGERPRINT` (comma-separated, one per
  signing cert) — only when this API itself serves the passkey association
  files on the RP ID host; unset, `/.well-known/apple-app-site-association`
  and `/.well-known/assetlinks.json` answer 404.
- `ANDROID_PASSKEY_ORIGIN` — comma-separated `android:apk-key-hash:<base64url
  SHA-256 of a signing cert>` values, one per cert an Android build may be
  signed or reported with. Keep it the same set as the SHA-256 fingerprints in
  `assetlinks.json`. List every cert in the app's history, not only the
  current one: after a signing-key rotation, Android can report the hash of an
  older cert. A missing one makes passkey sign-in and registration fail with
  "Authentication failed", and the API log says
  `Unexpected authentication response origin "android:apk-key-hash:…"` with the
  exact value to add. Convert a hex fingerprint with
  `python3 -c "import base64,sys;print(base64.urlsafe_b64encode(bytes.fromhex(sys.argv[1].replace(':',''))).rstrip(b'=').decode())" <SHA256>`.
  When a cert is added, also add its colon-separated hex SHA-256 to
  `ANDROID_SHA256_FINGERPRINT` wherever `assetlinks.json` is generated (the
  product site's build environment, or this API's env when it serves the file
  itself), and rebuild that site. Both lists must hold the same certs.
- `BETTER_AUTH_URL` / `BETTER_AUTH_APP_ORIGIN` — your deployed origin(s)
- `BETTER_AUTH_COOKIE_DOMAIN` — optional, parent domain for the session
  cookie (e.g. `.example.org`) when the app and api are on different
  subdomains. `BETTER_AUTH_COOKIE_PREFIX` — optional cookie name prefix
  (default `better-auth`); give each deployment that shares a parent cookie
  domain its own prefix, or the browser sends both deployments'
  same-named session cookies to each.
- **Force-update gate.** `GET /api/version` tells the native apps the
  oldest build still allowed per platform (`minBuild.android`,
  `minBuild.ios`: Android versionCode / iOS build number). The app checks it
  on launch and on every return to the foreground
  (`apps/native/src/hooks/useForceUpdate.ts`); below it, the app is replaced
  by a blocking **Update required** page (on Android, Google Play's
  immediate in-app update is offered first). A block is never newly imposed
  while the device moves at flying speed, and offline the app keeps
  working. Raise the minimum in the same deploy that ships a backend change
  older builds can no longer talk to.
  - Set it from the admin dashboard (**App versions**: `GET`/`POST
    /api/admin/app-versions`, stored in the `app_min_build` table). The
    dashboard also lists the builds that launched since the api started,
    with counts, so you see what a new minimum would block. Takes effect
    within about a minute, no restart.
  - `APP_MIN_BUILD_ANDROID` / `APP_MIN_BUILD_IOS` — optional defaults used
    while the dashboard has not set a value (unset = `0` = no minimum).
  - `APP_MIN_VERSION` — optional semver floor, defaults to `0.0.0` (no-op).
    Read by app builds from before build-number support (they only offer
    the store's own update flow, which can be dismissed); newer builds check
    it too. Prefer the build minimum: the version name is not raised with
    every build.
- `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` — optional, enables POH
  PDF auto-fill (`/api/poh-extract`); the app works without it. Filling a
  profile from a POH through the pilot's own AI assistant (copy the prompt,
  paste the answer back) needs no server configuration and works either way.
  `AZURE_OPENAI_DEPLOYMENT` names the model deployment. Each extraction sends
  the whole PDF to the model in one request and costs real money, so it is
  guarded: login required, and these limits, all optional positive integers:
  `POH_DAILY_LIMIT` (5) and `POH_HOURLY_LIMIT` (3) per user,
  `POH_GLOBAL_DAILY_LIMIT` (50) over all users (sign-up is open, so per-user
  limits alone do not bound the total), `POH_MAX_CONCURRENT` (2) running at
  once, `POH_MAX_PAGES` (250) per PDF and `POH_MAX_OUTPUT_TOKENS` (16000) for
  the answer. The counters are in memory, so a restart resets them. Each
  extraction writes one log line with its token usage and time.
- `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` — optional, enables live
  ADS-B traffic overlay. `OPENSKY_BBOX` (south,west,north,east) sets the
  area.
- `OGN_ENABLED` — default `true`: merges Open Glider Network traffic
  (FLARM, and ADS-B heard by OGN ground receivers) into the same overlay;
  no credentials needed. It covers the `OPENSKY_BBOX` rectangle unless both
  `OGN_FILTER_LAT` and `OGN_FILTER_LON` are set, which switch it to a circle
  of `OGN_FILTER_RADIUS_KM` (default 350) around that point.
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
- `ACS_CONNECTION_STRING` + `EMAIL_SENDER_ADDRESS` — optional, enable
  transactional email (Azure Communication Services Email) for auth OTP
  codes (or `BREVO_API_KEY` + `BREVO_SENDER_EMAIL` for Brevo instead, used
  when no connection string is set); without either, nothing is sent and, unless `NODE_ENV=production`,
  each message (sign-in code, account-deletion link) is printed to the api's console instead (fine for
  local dev and single-user self-hosting; with `NODE_ENV=production` only a warning without the code)
- `CHART_DOCUMENT_HOSTS` — optional, experimental. Comma-separated hostnames
  of official chart publishers whose PDFs `/api/charts/document` may pass
  through to the web app (in-app viewer and map overlay of charts listed in
  `<cc>-charts.json`, which the API reads from `TILES_BASE_URL`; see
  docs/architecture.md "Charts index"). Empty, or `TILES_BASE_URL` unset =
  endpoint disabled. Limits: `CHART_DOCUMENT_MAX_MB` (20),
  `CHART_DOCUMENT_HOURLY_LIMIT` (120) / `CHART_DOCUMENT_DAILY_LIMIT` (600)
  per user, `CHART_DOCUMENT_CACHE_MB` (100, shared in-memory). The web
  client shows charts to accounts with role `admin` only (there is no build flag). `CHART_DOCUMENT_ADMIN_ONLY=1` makes the endpoint itself refuse every other account (403),
  so the documents are admin-only for real, not just hidden in the UI.
- `TILES_BASE_URL` — optional, your public tile host (e.g.
  `https://tiles.example.org`); the admin country detail checks
  `manifest.json` and each country file there, and route briefings read the
  aerodrome, airspace and obstacle files from it. Unset = that check is
  skipped and briefings have no airspace or aerodrome data
- Fixed-code accounts, for sign-in without an inbox (both off by default):
  - `APP_REVIEW_TEST_EMAIL` + `APP_REVIEW_TEST_OTP` — one account for
    app-store review (both or neither).
  - `APP_TEST_ACCOUNTS` — `email:code,email:code`, any number of accounts for
    automated tests, kept separate from the review account.
  Each listed address signs in with its own fixed code instead of a random one
  (no email is sent) and cannot register passkeys. Codes are digits only (the
  login screens cannot type anything else) and at most 32 long, and must differ
  between accounts. The review account's code needs at least 10 digits; a test
  account's needs 32 (so exactly 32). A bad entry stops the api from starting. The
  codes never expire, so treat them as secrets and use dedicated addresses.
  See `apps/api/src/fixedOtpAccounts.ts`.

### Assistant connection (MCP, optional)

With `ASSISTANT_MCP=on` the api lets a pilot connect their own AI assistant
(any assistant that supports remote MCP servers with OAuth) to read
OpenVFR data: route briefings, aerodrome information, METAR/TAF and NOTAMs,
and, if the pilot allows it, their saved routes, places and aircraft and flight summaries. Changes need their own consent.

- UI visibility: `ASSISTANT_UI` is unset = only accounts with the admin role
  see the assistant parts of the web and mobile apps (connector address,
  connected assistants) while you verify it; `ASSISTANT_UI=all` shows them to
  every signed-in user. The MCP endpoint itself works for anyone who has the
  address and approves the consent, so this is not access control.
- MCP endpoint: `<BETTER_AUTH_URL>/mcp` (POST only). Discovery documents:
  `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`
  and `/.well-known/openid-configuration` (plus their path-suffixed forms),
  all on the api origin. Route them to the api in your reverse proxy
  (`docker/nginx.conf` has the locations); they are public, `/mcp` does its
  own token check.
- Sign-in and consent are pages of the web app:
  `<BETTER_AUTH_APP_ORIGIN>/oauth/login` and `/oauth/consent` (the SPA
  fallback must serve `index.html` there). The pilot sees the assistant's
  name and can leave out saved routes and aircraft, or flight summaries; the account panel lists
  connected assistants with Disconnect. The consent page marks an assistant
  as verified (its Client ID Metadata Document's domain) or not verified
  (self-registered: shows where it sends the browser back), and every
  approval is confirmed to the account's email address.
- Assistants identify themselves with a Client ID Metadata Document, or
  register themselves (open Dynamic Client Registration, 10 per hour per IP).
  A registered client can only get tokens for the MCP endpoint, and only
  after a user signs in and approves it. Access tokens last an hour; refresh
  tokens rotate, a replayed one is refused, and unused ones expire after 90
  days. Disconnecting an assistant deletes its consent and its refresh and access
  tokens (`assistantAccess.ts`; better-auth's own `delete-consent` removes only
  the consent), and every `/mcp` request checks that the user is not banned and
  still has a consent for that assistant, so both end access at once. An admin
  ban also deletes the user's assistant tokens. A token carries only the scopes
  the consent grants at that moment, so narrowing a consent narrows tokens issued
  before. Nobody manages OAuth clients over the api's own client endpoints
  (they are refused for every session); clients register themselves.
- The api removes expired and revoked tokens (a day after they end) and
  clients that registered but were never approved or were disconnected (after
  14 days), once a day.
- Tables `ba_jwks` and `ba_oauth_*` (migration `20261201000000`), used only by
  the api role.
- Testing with a real assistant during development: local MCP clients
  (coding assistants, the MCP SDK) can use `http://localhost`; cloud
  assistants need a public https URL. Put a tunnel in front of the web dev
  server (it proxies `/api`, `/mcp` and `/.well-known/*`), set
  `BETTER_AUTH_URL` and `BETTER_AUTH_APP_ORIGIN` to the tunnel URL, give the
  api a real `BETTER_AUTH_SECRET` (the dev default is refused on https) and
  let Vite answer to the tunnel host with `VITE_DEV_ALLOWED_HOSTS`.
- Scopes: `briefing:read` (every token), `routes:read` (saved routes, places and
  aircraft), `routes:write` (create and change saved routes and places),
  `aircraft:write` (create and change aircraft profiles; both writes need
  `routes:read` too, the consent page links them) and `logs:read`
  (per-flight summaries from `user_flight_logs`, selected without the
  `track_json` column: no GPS tracks; not preselected); writes never
  delete and are not preselected on the consent page. They go through
  PostgREST as the user, run the same checks as the app (route points are
  resolved against the aerodrome, navaid and reporting-point datasets from
  `TILES_BASE_URL`), and mark the route (`user_routes.assistant_review`) or
  profile (`assistantReview`) until the pilot saves it in the app.
- Server-side briefings use the same data as the apps: terrain from the DEM
  archives (`ELEVATION_DEM_SOURCES`, no third-party call) or else the
  `<cc>-mef.mef` grid from `TILES_BASE_URL`; forecast wind through the
  Open-Meteo proxy in-process, counted against the user's proxy caps; METAR/TAF
  through the weather cache; the user's synced MSA margins, airspace alert
  levels, planned departure and global wind.
- Limits: `MCP_HOURLY_LIMIT` / `MCP_DAILY_LIMIT` (tool calls per user, default
  120 / 600), `MCP_WRITE_HOURLY_LIMIT` / `MCP_WRITE_DAILY_LIMIT` (route and
  aircraft writes, default 20 / 60); briefing tools also count against `BRIEFING_*` and weather
  lookups against `WX_*`. Saved routes and aircraft need
  `POSTGREST_INTERNAL_URL`; briefings need `TILES_BASE_URL`.

### Admin API

`/api/admin/*` (user list, sign-up/activity stats, ban/unban, enabling
countries, per-country data status and pipeline runs, external-API relay
usage, minimum native app build) is a JSON API
for an operator dashboard. This repo ships only the API; the admin web UI is
deployed separately on its own origin, so script on the main app's origin can
never drive it. Set `ADMIN_APP_ORIGIN` to that UI's origin (e.g.
`https://admin.example.org`): it is trusted for sign-in and passkeys, and it
becomes the *only* origin `/api/admin/*` accepts (requests with any other
`Origin` get 403). Also allow that origin in your reverse proxy's CORS for
`/api/auth/` and `/api/admin/`.

Access requires `ba_user.role = 'admin'`. There is no signup path for it --
grant it by hand after the account exists:

```sql
UPDATE ba_user SET role = 'admin' WHERE email = 'you@example.org';
```

A compromised mailbox (email OTP) alone must never be enough, so admins need a
second factor, in one of two modes:

- **Passkey-only (default).** The admin account needs a registered passkey,
  and email-OTP sign-in is refused for admin accounts. Bootstrap: sign in by
  OTP, register a passkey, *then* grant the role. Lost the passkey? Demote
  (`SET role = 'user'`), sign in by OTP, register a new passkey, promote again.
- **Cloudflare Access.** If the admin UI and `/api/admin/*` sit behind a
  Cloudflare Access application, set `CF_ACCESS_TEAM_DOMAIN` (e.g.
  `myteam.cloudflareaccess.com`) and `CF_ACCESS_AUD` (the application's
  Audience tag). The api then verifies the `Cf-Access-Jwt-Assertion` token on
  every admin request (signature, audience, issuer, expiry, and that its email
  matches the admin account) and email-OTP sign-in is allowed for admins. Use
  an Access login method that is not the same mailbox.

Either way admin sessions expire after `ADMIN_MAX_SESSION_HOURS` (default 12).

Admins see account metadata and aggregate counts only -- never routes,
positions or flight logs. Banning uses better-auth's admin plugin: it
revokes the user's sessions and blocks sign-in while `banned` is set
(optional expiry). A ban is stored on the user row, so deleting the account
removes it. An already-issued PostgREST JWT stays valid until its 15 min expiry.

### Curated aerodrome details and their preview files (optional, experimental)

If your data pipeline publishes `<cc>-aerodrome-details.geojson` (circuits, noise-sensitive areas, holdings), the
app draws them (no build flag: without the file nothing is shown). A pipeline
may also publish `<cc>-aerodromes.preview.geojson` and `<cc>-aerodrome-details.preview.geojson`: the same data with values that
have not been reviewed yet, marked. The app reads them only when a signed-in **admin** switches Settings → "Curated data" to
"Include unreviewed"; everyone else always reads the approved files. **The preview files sit on the same public tile host as every
other file: anyone who knows the URL can download them.** The admin switch decides what the app shows, it is not access control. If
unreviewed values must stay private, do not publish the preview files to the public host.

### Operator notices (optional)

The apps can show notices such as planned maintenance or an outage. They are
read from a small public JSON document configured at build time
(`VITE_STATUS_URL` for web, `EXPO_PUBLIC_STATUS_URL` for native; unset = no
notices). Host it **apart from the api** (object storage, CDN, static host)
so it stays reachable when the api is down, with CORS allowing your web
app's origin and a short cache lifetime (about a minute). Add its origin to
the web app's CSP `connect-src` (`apps/web/public/_headers`; the build
rewrites the listed origins from `VITE_STATUS_URL`).

```json
{
  "version": 1,
  "messages": [{
    "id": "2026-11-15-maintenance",
    "severity": "warning",
    "title": "Planned maintenance",
    "body": "Sign-in and sync unavailable 06:00-07:00 UTC. Maps and offline data keep working.",
    "startsAt": "2026-11-15T05:00:00Z",
    "endsAt": "2026-11-15T07:00:00Z",
    "platforms": ["web", "android", "ios"],
    "url": "https://example.org/status"
  }]
}
```

`severity` is `info`, `warning` or `critical`; only `id`, `severity` and
`title` are required. A notice shows between `startsAt` and `endsAt` (each
optional); `info`/`warning` can be dismissed per `id`, `critical` stays
until `endsAt`. `platforms`, `minAppVersion` and `maxAppVersion` narrow who
sees it. Text is plain (no HTML) and length-limited; invalid entries are
ignored. Rules and limits: `packages/shared/src/systemMessages.ts`. The apps
re-fetch every 10 minutes and when brought to the foreground, and keep the
last copy for offline use.

### Upgrading a database created before the `openvfr_` role prefix

The database roles were renamed so they cannot collide with another project's roles on a shared Postgres server
(roles belong to the whole server, not to one database): `anon`, `authenticated`, `authenticator`, `api_app`,
`cron_app`, `martin_ro` became `openvfr_anon`, `openvfr_authenticated`, `openvfr_authenticator`, `openvfr_api`,
`openvfr_cron`, `openvfr_martin`. The migrations were edited in place, and `dbmate` does not re-run migrations it
already applied, so an existing database keeps the old names. Either start over (local development:
`docker compose down -v`) or rename the roles once, as the `openvfr` superuser, **on a server that holds nothing but
this database** (grants, policies and memberships follow the role):

```sql
ALTER ROLE anon          RENAME TO openvfr_anon;
ALTER ROLE authenticated RENAME TO openvfr_authenticated;
ALTER ROLE authenticator RENAME TO openvfr_authenticator;
ALTER ROLE api_app       RENAME TO openvfr_api;      -- only if your database has it
ALTER ROLE cron_app      RENAME TO openvfr_cron;     -- only if your database has it
ALTER ROLE martin_ro     RENAME TO openvfr_martin;   -- only if your database has it
```

Then set `PGRST_DB_ANON_ROLE=openvfr_anon` for PostgREST and use the new role names in the connection URLs of the
api, PostgREST and cron (and re-set their passwords: renaming clears an MD5 password).

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
  `curl -sI -H 'Range: bytes=100000000-100016383' https://<tiles>/se-basemap.pmtiles`
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
  `curl -sI https://<tiles>/se-basemap.pmtiles | grep -i cf-cache-status`
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
- Request body size in your reverse proxy: `/rest/` needs at least 17 MB
  (a flight log is uploaded in one request; its 1 Hz track passes nginx's
  1 MB default after about 2 h of flight, and the database caps one track
  at 16 MiB), `/api/poh-extract` at least 51 MB (50 MB PDF). The API itself
  caps every other `/api/*` body at 1 MB.
- `/api/open-meteo/` (model wind, Open-Meteo) and `/api/elevation/`
  (terrain, OpenTopoData) are relayed by the API server
  (`apps/api/src/externalProxy.ts`): session required, per-user caps, a
  response cache, and a server-wide budget kept under the free tiers'
  per-IP limits (Open-Meteo 600/min, 5 000/h, 10 000/day; OpenTopoData
  1/s, 1 000/day), which all your users share because they leave through
  your server's IP. In any reverse-proxy config of your own, route these
  two paths to the API like `docker/nginx.conf` does: not straight to the
  third-party hosts, and without an nginx cache (it would answer cached
  requests without the session check). `EXTERNAL_PROXY_ANONYMOUS` (API
  server env): `off` (default) answers requests without a session 401;
  `limited` still serves them, with tight per-IP caps and a capped share of
  the upstream budget, only for app builds that predate the session
  requirement. Any other value means `off`. `OPEN_METEO_MAX_IN_FLIGHT`
  (1-4, default 2): Open-Meteo requests the relay keeps in flight at once;
  the free API processes one request per IP at a time and rejects more than
  five pending, so lower it to 1 if other software shares your public IP
  and the api logs `429 (Too many concurrent requests)`.
- Terrain does not depend on OpenTopoData's small free budget alone: whenever
  it can't answer at once (the caller's hourly/daily cap used up, the
  server-wide budget used up or paused after a 429/503, a queue longer than
  2 s, or an error) and no cached answer exists, the API answers
  `/api/elevation/` from your own `<cc>-hillshade.pmtiles` (Copernicus
  GLO-30, ~75-150 m per pixel at the archive's max zoom, coarser than
  OpenTopoData's 25 m but fine for the profile, MSA and AGL limits). Those
  answers cost no upstream budget (`X-Cache: LOCAL`; own per-user cap of
  3 000/h, 20 000/day). `ELEVATION_DEM_SOURCES` (API server env): unset =
  `<TILES_BASE_URL>/<cc>-hillshade.pmtiles` for every available country
  (nothing when `TILES_BASE_URL` is unset); `off`; or a comma-separated list
  of archive URLs and/or absolute file paths (e.g. a volume with the archives
  mounted into the API container, which avoids HTTP entirely). Over HTTP the
  API only accepts `206` answers no larger than the range it asked for, so
  the Range requirement on the tile host above applies here too. The set is
  re-read every hour (every 2 minutes after the registry or an archive
  could not be read), so new countries and rebuilt archives are picked up.
- Model wind/weather does not have to depend on Open-Meteo's free budget
  either: the API answers `/api/open-meteo/` locations from precomputed
  per-country **weather grids** (`apps/api/src/wxGrid.ts`) whenever a grid
  holds the exact request (`X-Cache: LOCAL`, no upstream budget, own
  per-user cap of 3 000/h, 20 000/day). The apps only ever ask for points on
  a 0.05° lattice (`snapCoord`) or at aerodrome coordinates, in knots and
  unix time, so a finite set of points per country covers every in-country
  request; points outside every grid, other request shapes and grids older
  than 2 h go the normal relay way (cache, then upstream). A grid is an
  `OVWX` file (layout documented at the top of `wxGrid.ts`): Open-Meteo's
  answers for every lattice point inside the country plus a sea/border
  buffer and for each aerodrome — `minutely_15` slots of the surface bundle
  and all pressure-level winds (Open-Meteo's `current` is the `minutely_15`
  value of the current slot), and optionally hourly wind per level from
  00:00 UTC yesterday for 17 days (route-planning forecast wind; without it
  those few requests use the upstream budget) — produced by a scheduled job of your own against a
  self-hosted Open-Meteo instance (`ghcr.io/open-meteo/open-meteo` in remote
  mode answers exactly like the public API with its default model
  selection; self-hosting has no call limits and no commercial-use
  restriction). Publish each build under a new file name and then a pointer
  `{"file": "<name>.wxg"}` next to it; the API re-reads pointers every 2
  minutes and reads grids with Range requests (same `206` rule as above).
  Serve the pointer with `Cache-Control: no-cache` or a max-age of at most
  ~60 s, and make sure your tile host / CDN does not override that with a
  long edge TTL: a pointer cached for hours keeps the API on an old grid,
  which it stops using after 2 h (requests then go upstream again). The
  `.wxg` files themselves never change and may be cached like the other
  versioned tile files.
  `WX_GRID_SOURCES` (API server env): unset =
  `<TILES_BASE_URL>/wx/<cc>/latest.json` for every available country
  (nothing when `TILES_BASE_URL` is unset; a missing pointer just means no
  grid for that country); `off`; or a comma-separated list of pointer and/or
  `.wxg` http(s) URLs / absolute file paths (relative paths are ignored with
  a warning; the same rule applies to `ELEVATION_DEM_SOURCES`). The admin External APIs data shows
  which grid each country uses and its age.
  Open-Meteo's free tier is for
  non-commercial use only (open-meteo.com/en/terms); a commercial
  deployment needs an Open-Meteo API subscription.
