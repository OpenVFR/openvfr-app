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
- **Never name a third-party product, brand, app, or website as a design reference** in code comments, commit messages, docs, or PR descriptions — describe a technique or behavior on its own technical merits, not by who else does it. "Third-party" is broad on purpose: not only competing EFBs, but also weather sites, sim-connect tools, chart providers, any "X-style" / "like X" / "X's convention" phrasing. Also never adopt another product's *feature name* as the name of ours. This applies to independently-researched techniques too, not just copied ones. Naming a data source, library, or protocol we actually consume (OpenAIP, Open-Meteo, MapLibre, X-Plane's UDP port) is fine — that's attribution, not comparison. (Deliberately not listing bad examples here — doing so would put those names in this file's own text.)
- **Never commit personal or deployment-specific identifiers** — personal domains, LAN IPs, local file system paths, personal email addresses, account/org names, or any detail tied to one operator's own infrastructure/hosting setup. This repo is generic and self-hostable (see `docs/self-hosting.md`); it does not describe or reference any specific production deployment. Two carve-outs, both narrow:
  - The project's own `*.openvfr.org` hosts may appear only as *documented, env-overridable defaults* (`vite.config.ts` dev proxies, `wrangler.jsonc`) explicitly labelled as the maintainers' instance. Never as the only option, never in code paths a self-hoster can't redirect.
  - Build-account identifiers (EAS project ID/owner, Apple team ID, Android signing fingerprints) go through env vars — `apps/native/app.config.js` for Expo, `.env.example` placeholders for the rest. `app.json` and `eas.json` stay account-agnostic.
- **Never reference files or paths in private repositories** (the sibling infra repo or any other). Public readers can't follow them, and the reference rots silently. State the relevant fact inline (a bbox, a rate limit, a schedule) or point at `docs/self-hosting.md` / `docs/architecture.md`. The one exception is this file's own maintainer note in the Server API Security Baseline below, which exists precisely to warn that the private repo has its own review rules.
- **Scratch/handoff notes are not repo files.** Investigation logs, agent handoff documents, TODO dumps, etc. live in a gitignored `.scratch/` directory, never at the repo root. If a finding is worth keeping, it becomes a gotcha in this file or a section in `docs/`, reviewed like code.
- **Docs follow code in the same change.** Any change to an env var, config default, trusted-origin list, script name, or CLI flag updates every README/`docs/` mention and the relevant `.env.example` in the same PR. Stale docs describing behavior that no longer exists have already happened here once.
- **Everything is public.** Comments, commit messages, PR text, and workflow logs are read by strangers. Write for them: no internal shorthand, no "as discussed", no references to private conversations or chats.
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
| `packages/shared/src/autoFlyDetect.ts` | Takeoff/landing detector behind the Auto flying mode setting — see `docs/architecture.md` §7 |
| `packages/shared/src/virtualRadarCalc.ts` | Vertical-profile computation engine, shared web + native |
| `packages/shared/src/fetchWithRetry.ts` | Retry-with-backoff wrapper — see the connectivity-gap gotcha below |
| `@open-vfr/shared/{airspaceColors,featureColors}` | The **only** source of aviation-domain colours — see the colour-palette gotcha below |

---

## Critical Gotchas

**Airspace filter timing:** `map.getFilter()` is unreliable right after `styledata`. Use the `AIRSPACE_BASE_FILTERS` constant (`map-style.ts`) to rebuild combined filters instead of reading back from the map.

**Airspace `lower_ft`/`upper_ft` are in the limit's own reference, not altitudes:** `FL` → FL×100 on 1013.25 hPa, `ft MSL` → as published, `AGL`/`GND`/`SFC` → the raw height above ground (e.g. `"300m AGL"` → `984` everywhere, regardless of terrain). Never compare them with own altitude directly — go through `@open-vfr/shared/airspaceAltitude` (`altitudeForLimit`, `effectiveLimitFt`, `limitMarginFt`, `insideBand`) in alert hooks and `applyTerrainToBands` for the vertical profile. The map ceiling filter (`lower_ft <= ceilingFt`) is the one place raw values are fine (conservative). Same-named sectors differ only by limits (RONNEBY CTR vs TMA) — keys must include them.

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

**Wind-barb icon colours are baked into native's PNGs — regenerate on change.** Web draws `wind-barb-*` map icons on a canvas at runtime (`apps/web/src/utils/windBarbIcons.ts`), so it always reflects `@open-vfr/shared/windBarb`'s `windBarbColorForSpeed`/`windArrowStrokeWidth` live. Native can't recolor at runtime — its 21 `wind-barb-{0,5,...,100}.png` assets (`apps/native/assets/poi_icons/`) are pre-rasterized by `apps/native/scripts/gen-wind-barb-icons.mjs`, a manual one-off script (not wired into any `package.json` script, same as its `gen-poi-icons.mjs`/`gen-aircraft-icons.mjs` siblings). Any change to `windBarb.ts`'s speed-tier colours or the barb geometry itself needs `node scripts/gen-wind-barb-icons.mjs` re-run from `apps/native/`, or native silently falls out of sync with web.

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

**Native memory budget — don't mount a heavy PMTiles source until its layer is actually turned on.** `layout={{ visibility: 'none' }}` only hides a *layer* at paint time; it does **not** stop MapLibre Native from loading its *source* the instant the `<VectorSource>`/`<RasterDEMSource>` JSX mounts (header fetch happens immediately regardless of visibility, and tile fetches follow once any layer using it becomes visible). `AviationMap.tsx` previously always-mounted `osm-landuse` (87MB), `osm-hillshade` (231MB+), and `osm-contours` (117MB+) from app launch — confirmed via `adb logcat` as a genuine `OutOfMemoryError` in the OkHttp networking thread even with `android:largeHeap="true"` raising the ceiling to 512MB (`plugins/withAndroidLargeHeap.js`). The OOM manifested downstream as a MapLibre `pmtiles magic number exception` (a truncated mid-read response under memory pressure, not a corrupt file) — easy to misdiagnose as a server/CDN/cache bug instead of a client memory bug; always check `adb logcat -s ReactNativeJS:V AndroidRuntime:E` for an actual `OutOfMemoryError` stack first before assuming file corruption. Fix pattern (see `landuseMounted`/`hillshadeMounted`/`contoursMounted` in `AviationMap.tsx`): gate each heavy `<VectorSource>`/`<RasterDEMSource>` JSX block behind a **sticky-on** boolean that only ever flips true once its `show*` prop is first true, and never resets — MapLibre Native throws `id cannot be changed` if a source is unmounted then re-added, so this can only ever turn a source *on* for the rest of the session, never off. Apply the same pattern to any future heavy/optional map source. Two further layers of defence, same file/screen: (1) stage transitions (`readyStage` 1→2→3) wait for the map's own settled-frame event (`onDidFinishRenderingMapFully`, with a min floor and a fallback ceiling) instead of fixed timers, so heavy sources never overlap their startup fetches regardless of network speed; (2) on devices with under 4 GiB RAM (`src/utils/deviceMemory.ts`, `expo-device`), `MapScreen.tsx` locks hillshade/contours/terrain-colour off and `MapDisplaySheet` disables those rows (`terrainMemoryLocked`), the same shape as the satellite in-flight lock. `expo-device` is a native module: adding or upgrading it needs a native rebuild, not just a bundle reload.

**PMTiles Range requests must never be answered with the whole archive -- and MapLibre will not protect you.** Root cause of the recurring Android `OutOfMemoryError` (first seen at the 256 MB default heap, then again at the 512 MB `largeHeap` ceiling after `withAndroidLargeHeap` raised it), found by capturing a heap dump mid-climb with `am dumpheap` and walking it: 238 MB of `okio.Segment` buffers, ALL held by ONE `okhttp3.Response` whose request was `Range: bytes=338922143-338971007` (a 48 KB PMTiles slice of the 668 MB `basemap.pmtiles`) but whose response was `200 OK`, `Content-Length: 668248225` -- the origin ignored the Range header and sent the entire archive. Reproduced from a workstation: intermittent, `cf-cache-status: BYPASS` (668 MB is over Cloudflare's per-object cache limit, so every request hits origin), 4 retries returned the correct `206`. MapLibre Native's own Android HTTP layer (`HttpRequestImpl$OkHttpCallback.onResponse`, verified in the 13.6.1 bytecode) accepts any 2xx and then calls `ResponseBody.bytes()` -- no size check, no "was my Range honoured" check -- so it buffers the whole archive into the Java heap. Fix: `plugins/withMapLibreHttpGuard.js` installs a replacement OkHttp client via `HttpRequestUtil.setOkHttpClient()` whose interceptor throws (into MapLibre's normal retry path) BEFORE the body is read when a Range request is not answered with 206, or when `Content-Length` / the streamed body exceeds 32 MB. The signature to recognise in `adb logcat`: Java heap climbing ~30 MB/s from ~30 MB toward the ceiling with continuous `concurrent mark compact GC` lines, `OutOfMemoryError` on the `OkHttp TaskRunner` thread, then the heap dropping straight back (single transient allocation, not a leak). To diagnose any future heap OOM the same way: `dumpsys meminfo <pid>` sampled per second to catch the climb, `am dumpheap <pid> /data/local/tmp/x.hprof` at ~250 MB, `hprof-conv`, then a class histogram + reverse-reference walk (a 150-line Node script suffices; no Android Studio needed). Hosting contract for self-hosters: the tile host MUST honour HTTP Range on `.pmtiles` with `206 Partial Content` on every request -- see docs/self-hosting.md.

**Offline terrain reads the hillshade PMTiles directly: keep it on ranged local reads.** `@open-vfr/shared/terrainDem` (`PmtilesDem`) decodes single Terrarium PNG tiles from `se-hillshade.pmtiles` for the vertical profile / AGL fallback when the elevation API is down. Native (`apps/native/src/utils/terrainDem.ts`) only ever opens the *cached local file* with `File.open()` + `readBytes` (one ~130 KB tile per read, 6-tile Int16 LRU, < 1 MB resident); it must never be pointed at a remote URL through RN `fetch()` for the reasons in the two gotchas above. Web uses pmtiles' `FetchSource`, which already aborts a 200-with-full-body response. Do not raise `TILE_CACHE_SIZE` or switch to parallel sampling without re-checking heap on a low-memory device.

**Large GeoJSON must never go through `fetch()` on native either.** Separate from the PMTiles issue above but the same failure shape: React Native's Android networking holds a `fetch()` response body in the Java heap as raw bytes, then again as a UTF-16 `String` (2x), then streams it to JS in JSON-encoded chunks. `VerticalProfile` used to `fetch()` the 24 MB `se-water.geojson` (every lake in Sweden, for the lake-crossings overlay) on mount -- measured as a 47 MB large-object allocation followed by a sustained climb. It is now excluded on native (`buildVirtualRadarProfile` accepts water as undefined; the chart just omits lake crossings). Rule: anything above a few MB stays out of RN `fetch()` -- serve it as PMTiles through MapLibre's native loader, or don't load it on native. The `useResilientTileData` files (airspace, aerodromes, navaids, waypoints, runways, obstacles, landmarks) are 0.1-3 MB and fine.

**Offline-cache integrity 	 - `File.exists` is not enough.** `offlineCache.ts`'s `isCached()`/`resolveUri()` previously only checked whether a downloaded asset file existed on disk, not whether it was actually complete. An interrupted download (network drop, app backgrounded mid-transfer, disk full) can leave a 0-byte or truncated file that still passes `.exists` - that file then gets handed to MapLibre Native as if it were a valid local pmtiles/geojson asset, producing the same `pmtiles magic number exception` (or a GeoJSON parse failure) purely from stale local state, with the remote copy on R2 perfectly fine. Any new cached-asset check in this file (or a similar pattern elsewhere) must verify `(file.size ?? 0) > 0` - or better, a real integrity check against the manifest's sha256 - not just existence, and `downloadAssets()` must delete-and-retry (never leave a stale partial file in place) on any incomplete/failed download.

**Saved-route identity — link by id, not by name.** The working route (`routes` collection row `id='current'`) carries an optional `linkedRouteId` (web: `useRouteDb.ts`'s `activeRouteId`) pointing at the saved-route row it was loaded from, or `''` when untitled. `RouteLibrary.tsx`'s "Save" button updates that exact row via `saveRoute(..., routeId)`; "Save As…" always mints a fresh id instead of matching by name, even when the typed name collides with the row being copied from — otherwise a same-named Save As silently overwrites the original instead of creating a copy. The untitled-route path (no linked row yet) is the one case that still matches by exact `name` string to decide overwrite-vs-insert, since there's no id to link to before the first save. Any change to route save/load flows on either platform must preserve this id-first rule; matching purely by name reintroduced the exact duplicate-row bug this replaced (see `useRouteDb.ts`'s `saveRoute` comment, dated 2026-09-13).

**Satellite basemap is planning-only — locked off in every flight mode.** The imagery provider's terms class aircraft navigation as a "High Risk Activity" the data is not intended for, so web (`MapView.tsx` `satelliteLocked` → `LayerPanel`) and native (`MapScreen.tsx` effect → `MapDisplaySheet` `satelliteLocked`) both force vector when any flight mode (GPS or Simulate) starts and disable the Satellite option until it ends. Native persists the change so a mid-flight restart also comes back in vector. Any new basemap picker or flight-mode entry point must keep this gate.

**In-flight route-edit lock — default to locked, require an explicit unlock.** Waypoint/leg-midpoint dragging must never be reachable by an ordinary map pan while airborne — touchscreens get knocked around in flight, and a leg silently moving mid-flight is a real hazard, not a cosmetic bug. Web (`MapView.tsx`) gates every route-line/waypoint/midpoint `mousedown`/`touchstart` handler behind `planningMode || routeAdjustMode`; when flying with `routeAdjustMode` off (the default), those handlers return immediately and the touch falls through to normal map panning. Native (`AviationMap.tsx`) mirrors this with an `editLocked` prop that, when true, skips rendering the `WaypointDragAnnotation`/`LegMidpointAnnotation` view-annotations entirely rather than relying on the native SDK's long-press-to-engage gesture as the only safeguard. `MapScreen.tsx` sets `editLocked = flyingActive && !routeAdjustMode` and resets `routeAdjustMode` to `false` on every flight start, so a forgotten toggle from a previous flight never carries over. Any new drag-based route-editing surface on either platform must be gated the same way, not just rely on a deliberate-gesture requirement as the sole protection.

**Wx tab METAR/weather-station toggle — two sources, always both fetched, never blended.** The Wx tab (web `AerodromePopup.tsx`'s Wx tab; native `AerodromeWxSection.tsx`, shared by `AerodromePopup.tsx` and `VicinityBriefSheet.tsx`) lets a pilot pick between exactly two sources, never a silent auto-blend of the two: **METAR** (`wx`, `@open-vfr/shared/fetchWx`'s `fetchWxResolved()` — the aerodrome's own report, auto-falling back to the nearest station with one, unchanged single-source behaviour) vs **Weather station** (`ambientWx`, `@open-vfr/shared/fetchWind`'s `fetchAmbientWx()` — Open-Meteo's non-aviation current-conditions model at the aerodrome's own coordinates: wind/temp/cloud-cover/surface-pressure/precipitation, always fetched regardless of METAR availability or auth, since it needs neither — proxied straight through at the nginx level, see the Server API Security Baseline note below). Both fetches run unconditionally and in parallel on load; the toggle just picks which already-fetched object drives the UI — no network round-trip on toggle. `wxSource` selects `effectiveWind` (METAR's own wind however far away that station is — no silent auto-swap to modelled wind past some distance threshold, that's what the Weather station tab is *for*; vs Open-Meteo's `ambientWx` wind) and therefore the suggested/favoured runway end and the map's `runway-threshold-label` highlight via `onRunwayWind` — native's `deriveWxDisplay()` takes `wxSource`/`ambientWx` as explicit params precisely so this selection logic isn't duplicated per screen. `metar` (decoded METAR) and TAF always come from `wx` regardless of which tab is selected — only `effectiveWind`/`windIsModelled` switch. Reset `wxSource` back to `'metar'` whenever the aerodrome changes, then auto-switch to `'station'` only if the METAR search comes back completely empty — a stale manual pick from a previous aerodrome must never carry over. `fetchWxNearest`/`fetchWxResolvedForPoint` (own `WxResolved.modelWind` distance-gated swap) stay unchanged and keep powering the non-interactive surfaces (map-wide wx-based aerodrome highlight, route wind sampling) that have no toggle UI — don't route those through the two-source split above.

**Many independent position-driven hooks compound into React's re-render safety limit — consolidate, don't just guard each one.** Each of native's per-tick GPS hooks (airspace warnings, obstruction proximity, airfield proximity, airspace entry/exit notifications) individually skipped `setState` when its own computed result was unchanged (a last-committed-signature check) — that alone fixed a single Class C airspace transition tripping React's "Maximum update depth exceeded" limit in `MapScreen.tsx` during Simulate mode. It did NOT fix two Class C airspaces transitioning in the same GPS tick: that's two hooks each *legitimately* producing a new result at once, correctly guarded individually, but still two independent `setState`-triggered commits stacking onto a screen that already runs several other position-driven hooks (`useNearbyFrequencies`, `useWind`, `useAltitudeSource`, `useTerrainElevation`, `useLivePlog`, …) off the same GPS tick. The fix was combining the four alert-producing hooks into one (`usePositionAlerts.ts`): one evaluation effect, one feature-fetch cache (was fetching the airspace GeoJSON twice, once per hook), and state updates for a tick issued synchronously in the same effect invocation so React 18's automatic batching coalesces them into a single commit regardless of how many categories changed. Any new position-driven hook added to a screen that already has several should be evaluated for whether it can join an existing combined-evaluation hook instead of adding a new independent `useEffect`/`setState` pair.

---

## Server API Security Baseline (Non-Negotiable)

Every endpoint added to `apps/api/src/index.ts` MUST be checked against this list before merging:

1. **Auth-gate anything that costs money or touches user data.** Paid third-party API calls or user-data reads/writes require `auth.api.getSession({ headers: c.req.raw.headers })`, 401 if `!session?.user`. Public endpoints are the exception — justify in a comment why (`/health`, public read-only data, `/.well-known/*`).
2. **Per-user rate limiting on any paid-API-backed endpoint**, in addition to auth. Minimum: hourly + daily cap (see `checkPohRateLimit`/`checkHourlyLimit` for the reference pattern — in-memory sliding window keyed by `session.user.id`). In-memory is fine for a single instance; move to Redis/DB only if scaling out.
3. **Input size/type caps before expensive work** — validate file size and MIME/extension before disk writes or downstream calls.
4. **Full error detail server-side, sanitized error to the client.** Log `status`/`code`/`type`/`body`/`stack` from SDK errors — never trust `err.message` alone. Client text stays generic, never leaks internal config.
5. **State explicitly whether a new endpoint needs auth + rate limiting** in its PR — never assume "nobody will hit this."

Reference implementation: `/api/poh-extract` in `apps/api/src/index.ts`.

6. **The api does NOT connect as a superuser.** Production runs it as the
   `api_app` role (`db/migrations/20260913000000_least_privilege_roles.sql`),
   which only has CRUD on the `ba_*` auth tables. PostgREST connects as
   `authenticator` (NOINHERIT) and can only `SET ROLE anon|authenticated`.
   Any new table the api reads/writes directly needs an explicit `GRANT`
   to `api_app` in the same migration that creates it, or prod fails with
   `permission denied` while dev (superuser `openvfr_dev`) keeps working.
   User data still goes through PostgREST + RLS, not the api.
7. **Client IP:** better-auth is configured (`auth.ts`) to trust only
   `cf-connecting-ip` / `x-real-ip`, which the infra nginx sets from
   Cloudflare's edge header. Never read `x-forwarded-for` for anything
   security-relevant -- the client controls its first entry.

**Maintainer note — this checklist does NOT cover everything reachable on the
maintainers' hosted API.** The production reverse proxy (`nginx.prod.conf` in
the private `openvfr-infra` repo, which self-hosters replace with their own
`docker/nginx.conf`-derived config) has its own `location` blocks that proxy directly to
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
