# OpenVFR — Agent System Context

You are an AI agent (or human contributor) working on OpenVFR, an open-source
European VFR Electronic Flight Bag (EFB).

Architecture reference: [`docs/architecture.md`](docs/architecture.md)
Self-hosting / data pipeline: [`docs/self-hosting.md`](docs/self-hosting.md)
Styling & React conventions: [`docs/styling.md`](docs/styling.md)
Contribution norms (commit style, PR expectations, licensing): [`CONTRIBUTING.md`](CONTRIBUTING.md)

---

## Core Constraints (Non-Negotiable)

- **Never use Mapbox GL JS v2+, Mapbox Studio, or any Mapbox API.** Use **MapLibre GL JS** exclusively.
- **Never use commercial tile APIs or services requiring proprietary API keys.** All data sources must be open-licensed.
- **Never reload the full MapLibre style object at runtime.** This drops aviation sources, resets all filters, and clears registered images. Use the runtime API (`map.addSource`, `map.addLayer`, etc.) for all dynamic changes.
- **`lang: 'sv'` is required** in `layers('protomaps', LIGHT, { lang: 'sv' })`. Without it, all label layers are silently omitted.
- **Never name a competing product** in code comments, commit messages, docs, or PR descriptions — describe a technique or behavior on its own technical merits, not by who else does it. This applies to independently-researched techniques too, not just copied ones. (Deliberately not listing examples here — doing so would put those names in this file's own text.)
- **Never commit personal or deployment-specific identifiers** — real domains, local file system paths, personal email addresses, or any detail tied to one operator's own infrastructure/hosting setup. This repo is generic and self-hostable (see `docs/self-hosting.md`); it does not describe or reference any specific production deployment.
- **Follow [`CONTRIBUTING.md`](CONTRIBUTING.md)** for commit message format, PR expectations, and dependency/data licensing review before any change.

---

## Project Identity

- **Stack:** React PWA + Vite (TypeScript, CSS Modules) → React Native (Expo) for the native app
- **Map engine:** MapLibre GL JS + `@protomaps/basemaps` v4 (web); MapLibre Native (native)
- **Map tiles:** PMTiles (single-file archive, HTTP Range Requests, no tile server)
- **Aviation data:** Static GeoJSON/PMTiles files, not included in this repo — see `docs/self-hosting.md`
- **Local DB:** RxDB via IndexedDB (web); AsyncStorage (native)
- **Backend:** Hono API (`apps/api`) + PostgreSQL/PostGIS + PostgREST + Martin tile server (dynamic data only)

## Repository layout

```
apps/
  web/       React PWA — see apps/web/src
  native/    React Native (Expo) app — see apps/native/README.md
  api/       Hono API server
packages/
  shared/    Code shared between apps/web and apps/native
db/
  migrations/  PostgreSQL + PostGIS schema (dbmate)
docker/      Dockerfiles + nginx/Martin config
docs/        Architecture reference, self-hosting guide, styling conventions
```

Full file-by-file map (component responsibilities, MapLibre source/layer IDs,
aviation data file schemas): see `docs/architecture.md` §2. A handful of
files worth knowing up front:

| File | Why it matters |
|---|---|
| `apps/web/src/styles/map-style.ts` | All MapLibre source IDs, layer IDs, and style definitions |
| `apps/web/src/components/MapView.tsx` | Mounts MapLibre, registers images, wires click handlers |
| `packages/shared/src/virtualRadarCalc.ts` | Vertical-profile computation engine, shared web + native |
| `packages/shared/src/fetchWithRetry.ts` | Retry-with-backoff wrapper — see the connectivity-gap gotcha below |
| `@open-vfr/shared/{airspaceColors,featureColors}` | The **only** source of aviation-domain colours — see the colour-palette gotcha below |

---

## Critical Gotchas

**Airspace filter timing:** `map.getFilter()` is unreliable right after `styledata`. Use the `AIRSPACE_BASE_FILTERS` constant (`map-style.ts`) to rebuild combined filters instead of reading back from the map.

**Airspace `class` vs `type`:** `class` = display bucket (`C`, `D`, `E`, `G`, `R`, `TRA`, `GLDR`, `MODEL`). `type` = raw OFMX `codeType` (`CTR`, `TMA`, `CTA`, `D`, `R`…). Both are needed — CTRs are `class=C, type=CTR`, ambiguous from `class` alone.

**Airspace inset shading band:** a wide, translucent `line` layer per class with positive `line-offset`, showing which side of the boundary is the airspace. Positive `line-offset` insets on `Polygon` geometry regardless of ring winding order (confirmed in the MapLibre style-spec). Must be registered in `AIRSPACE_BASE_FILTERS` and `LAYER_GROUPS.layerIds` alongside fill/border layers or the altitude/visibility filters won't apply to it.

**Airspace on-map labels:** use `symbol-placement: 'line'` so text repeats along the boundary and stays visible even off-screen. `text-offset` is a plain screen-relative offset (unlike `line-offset`) — it can occasionally render just outside the polygon depending on ring winding; accepted as a minor cosmetic limitation. Same registration requirement as the inset band, plus `AVIATION_LABEL_LAYERS` (web satellite-mode halo). Native symbol layers **must** include `'text-font': ['Noto Sans Regular']`.

**Protomaps POIs don't exist at our zoom level:** `pois` starts at minzoom=16; our basemap caps at maxzoom=12. Use OpenAIP for obstacle data instead.

**Basemap swap — never reload the style.** Use MapLibre's runtime API (`addSource`/`addLayer`/`removeLayer`/`removeSource`) so aviation sources and registered images survive the swap.

**Obstacle icons registered in `styledata`:** `map.addImage()` (via `svgIconLoader.ts`) must run inside the `styledata` handler since style re-applies on basemap swap. `hasImage()`/`inFlight` guards make repeat calls idempotent.

**`StyleSheet.create()` values are static.** They capture whatever a variable was at *module evaluation time*, not per-render — RN doesn't re-evaluate `StyleSheet.create` on every render. Anything depending on props/state needs an inline array style: `style={[styles.chartWrap, { height: chartH }]}`.

**Brief connectivity gaps must be tolerated everywhere:**
1. One-shot calls (weather, NOTAM, wind, terrain profile): use `fetchWithRetry()` instead of bare `fetch()` — 2 retries with exponential backoff, never retries an aborted request or permanent 4xx.
2. Long-lived streams (traffic SSE): rely on `EventSource`'s native auto-reconnect, gated by a watchdog timer clearing stale data only after prolonged silence.

**Never hardcode a copy of a shared colour palette.** Any aviation-domain colour (airspace class, navaid type, obstacle kind) belongs only in `@open-vfr/shared/{airspaceColors,featureColors}`. When class alone is ambiguous (CTR vs TMA, both class `C`), pass `type` through too. Values are `rgba(...)` strings, not hex — use a `withAlpha()` helper for translucent variants, not a hex-suffix trick.

**Shared-package `peerDependencies`:** `@open-vfr/shared` declares heavy libs (`geomagnetism`, `@turf/*`) as peer deps — each consumer (`apps/web`, `apps/native`) must list the real version itself. Check this before assuming a new shared util "just works" in native.

**JSX comment injection — never double-close.** A doubled `*/}` leaves a bare string as a View child; React Native Fabric throws an unhelpful "Text strings must be rendered within a <Text> component" with no useful stack trace.

**MapLibre RN v11 — Layer/Source API rules:**
- No `CircleLayer`/`SymbolLayer` components — use `<Layer type="circle"|"symbol">` with kebab-case `layout`/`paint`.
- Symbol layers **must** include `'text-font': ['Noto Sans Regular']` or the whole layer silently drops.
- `minzoom` (lowercase), not `minZoomLevel`. `VectorSource` uses `tiles` (array), not `tileUrlTemplates`.
- Hyphenated props (`source-layer`) need object spread: `{...{'source-layer': 'name'} as any}`.
- `setCamera()` removed in v11 — use `cameraRef.current?.easeTo()`/`flyTo()`/`jumpTo()`.
- Toggle visibility via `layout={{ visibility: 'visible'|'none' }}`, never unmount/remount (throws `id cannot be changed`).
- Layer's source-linking prop is `source`, **not** `sourceID` — the latter silently type-checks only when an adjacent `as any` spread widens the props object. Always use `source`.
- `hillshade`/`color-relief`/`RasterDEMSource` are real native-binary features on both platforms. `color-relief` has a known Adreno GPU bug — keep any new usage behind an explicit experimental toggle.

**MapLibre RN — touch interception:** the map surface intercepts all touches. Overlay controls must live **outside** the MapLibre View hierarchy, as absolute-positioned siblings.

**MapLibre RN — stable `mapStyle` reference / Hermes init order:** never call a style factory inline in JSX (`mapStyle={createStyle()}`) — new reference every render triggers a full basemap reload, and a top-level `const X = expensiveImport()` can throw `ReferenceError` under Hermes if the dependency isn't ready yet. See `AviationMap.tsx`'s `_protomapsStyle` lazy-singleton pattern for the fix — reuse it for any new style factory.

**Terrain colour-relief shares the hillshade DEM source.** Any layer added against `osm-hillshade` must be found generically, not hardcoded by id — see `MapView.tsx`'s region-swap `removeSource`/`addSource` cycle (search "Generic (not hardcoded...") for the existing pattern to extend.

**Farmland/landcover:** Protomaps' `landcover` layer fades out at zoom 7, invisible at aviation zooms (10–12). Farmland/residential/wetland at zoom 10+ comes from `se-landuse.pmtiles`.

**Native memory budget — don't mount a heavy PMTiles source until its layer is actually turned on.** `layout={{ visibility: 'none' }}` only hides a *layer* at paint time; it does **not** stop MapLibre Native from loading its *source* the instant the `<VectorSource>`/`<RasterDEMSource>` JSX mounts (header fetch happens immediately regardless of visibility, and tile fetches follow once any layer using it becomes visible). `AviationMap.tsx` previously always-mounted `osm-landuse` (87MB), `osm-hillshade` (231MB+), and `osm-contours` (117MB+) from app launch — confirmed via `adb logcat` as a genuine `OutOfMemoryError` in the OkHttp networking thread even with `android:largeHeap="true"` raising the ceiling to 512MB (`plugins/withAndroidLargeHeap.js`). The OOM manifested downstream as a MapLibre `pmtiles magic number exception` (a truncated mid-read response under memory pressure, not a corrupt file) — easy to misdiagnose as a server/CDN/cache bug instead of a client memory bug; always check `adb logcat -s ReactNativeJS:V AndroidRuntime:E` for an actual `OutOfMemoryError` stack first before assuming file corruption. Fix pattern (see `landuseMounted`/`hillshadeMounted`/`contoursMounted` in `AviationMap.tsx`): gate each heavy `<VectorSource>`/`<RasterDEMSource>` JSX block behind a **sticky-on** boolean that only ever flips true once its `show*` prop is first true, and never resets — MapLibre Native throws `id cannot be changed` if a source is unmounted then re-added, so this can only ever turn a source *on* for the rest of the session, never off. Apply the same pattern to any future heavy/optional map source.

**Offline-cache integrity — `File.exists` is not enough.** `offlineCache.ts`'s `isCached()`/`resolveUri()` previously only checked whether a downloaded asset file existed on disk, not whether it was actually complete. An interrupted download (network drop, app backgrounded mid-transfer, disk full) can leave a 0-byte or truncated file that still passes `.exists` — that file then gets handed to MapLibre Native as if it were a valid local pmtiles/geojson asset, producing the same `pmtiles magic number exception` (or a GeoJSON parse failure) purely from stale local state, with the remote copy on R2 perfectly fine. Any new cached-asset check in this file (or a similar pattern elsewhere) must verify `(file.size ?? 0) > 0` — or better, a real integrity check against the manifest's sha256 — not just existence, and `downloadAssets()` must delete-and-retry (never leave a stale partial file in place) on any incomplete/failed download.

---

## Server API Security Baseline (Non-Negotiable)

Every endpoint added to `apps/api/src/index.ts` MUST be checked against this list before merging:

1. **Auth-gate anything that costs money or touches user data.** Paid third-party API calls or user-data reads/writes require `auth.api.getSession({ headers: c.req.raw.headers })`, 401 if `!session?.user`. Public endpoints are the exception — justify in a comment why (`/health`, public read-only data, `/.well-known/*`).
2. **Per-user rate limiting on any paid-API-backed endpoint**, in addition to auth. Minimum: hourly + daily cap (see `checkPohRateLimit`/`checkHourlyLimit` for the reference pattern — in-memory sliding window keyed by `session.user.id`). In-memory is fine for a single instance; move to Redis/DB only if scaling out.
3. **Input size/type caps before expensive work** — validate file size and MIME/extension before disk writes or downstream calls.
4. **Full error detail server-side, sanitized error to the client.** Log `status`/`code`/`type`/`body`/`stack` from SDK errors — never trust `err.message` alone. Client text stays generic, never leaks internal config.
5. **State explicitly whether a new endpoint needs auth + rate limiting** in its PR — never assume "nobody will hit this."

Reference implementation: `/api/poh-extract` in `apps/api/src/index.ts`.

**This checklist does NOT cover everything reachable at `api.openvfr.org`.**
The production reverse proxy (`docker/nginx.prod.conf` — private `openvfr-infra`
repo, sibling checkout) has its own `location` blocks that proxy directly to
external third-party APIs (currently `/api/elevation/` → OpenTopoData,
`/api/open-meteo/` → Open-Meteo) WITHOUT ever reaching this Hono app at all —
none of the 5 rules above apply to them since `auth.api.getSession()` and
`checkHourlyLimit()` never run for a request nginx proxies straight through.
If you're adding a new external-API integration and considering an nginx-level
proxy (to dodge browser CORS, as these two do) instead of a Hono endpoint,
know that you're opting OUT of this entire checklist — that needs its own
explicit auth/rate-limit review in `openvfr-infra`'s `AGENTS.md` and
`nginx.prod.conf` instead, not silent trust that "it's just a proxy."

---

## Licensing

Dependency licensing rules: [`OSS-POLICY.md`](OSS-POLICY.md).
Aviation/map data source licenses and icon attribution: [README.md § Data & attribution](README.md#data--attribution).
