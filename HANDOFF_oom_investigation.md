# Handoff: Android release-build OOM ("no basemap" / app crash) follow-up

## Status
Root cause found and fixed (staggering, item #1 below). MapLibre Native
tuning (item #2) researched — no exploitable app-level knob found beyond
what's already applied; see "2. MapLibre Native (Android) tuning" below
for findings. One genuine crash was still reproduced during stress testing
after the original fix — this remains a risk-reduction fix, not a
structural guarantee (device also had ~15+ other background apps at the
time — general system memory pressure, not just this app's own burst).

## Root cause (confirmed via device logcat, not guessed)
Android release build, device: Samsung SM_S918B (`R5CW143GQFX`),
`org.openvfr.app`, `android:largeHeap="true"` (512MB ceiling). On cold
start / fresh sign-in, MANY heavy operations fired concurrently:
- `basemap.pmtiles` (670MB archive, HTTP Range Requests) — the base map
  style's own primary source, can't be deferred (MapLibre loads it as part
  of `mapStyle` immediately).
- `landuse.pmtiles` (~87MB) — was mounted immediately because
  `showLanduse` defaults `true`.
- `hillshade.pmtiles` (~231MB) / `contours.pmtiles` (~117MB) — default
  `false`, BUT their visibility is **persisted to AsyncStorage**, so a
  pilot who's ever enabled them will have them mount immediately on the
  NEXT cold restart too.
- Auth/session-restore, initial RxDB sync, weather/NOTAM/wind fetches, and
  traffic connect, all also firing around the same first-mount moment
  (weather/NOTAM/wind/traffic now gated via `mapReady` — see "Follow-up
  work done this session" §1 below; auth/RxDB sync left ungated, see same
  section for why).

This burst hits the 512MB heap ceiling. Two distinct failure signatures
were captured:
- `W/Mbgl-HttpRequest: Request failed due to a permanent error: Canceled`
  repeated many times + genuine `OutOfMemoryError` crashing an OkHttp
  background thread mid `basemap.pmtiles` header fetch → blank basemap,
  app stays alive (JS-catchable in principle, is what the styleLoaded/
  readyStage fix targets).
- A **harder** failure: `FATAL EXCEPTION: OkHttp TaskRunner` /
  `java.lang.OutOfMemoryError` thrown inside `okio.Segment.<init>` while
  receiving HTTP/2 stream data (`Http2Stream$FramingSource.receive$okhttp`)
  — this is an **uncaught native-thread crash that kills the whole
  process**. Confirmed via full `adb logcat -v threadtime`:
  `ActivityManager: Process org.openvfr.app (pid ...) has died: fg  TOP`.
  This bypasses ALL JS-level error handling (no React error boundary, no
  `onDidFailLoadingMap` callback — the process is gone). User has to
  manually relaunch the app from the home screen. Confirmed reproduced
  even AFTER the fix below, during a `force-stop` → immediate `am start`
  stress-test cycle (device also had ~15+ other apps installed/running in
  background at the time — general system memory pressure is likely a
  contributing factor, not just this app's own startup burst).

## Fix already applied (`apps/native/src/components/AviationMap.tsx`)
1. Added `styleLoaded` state, set via new `onDidFinishLoadingStyle` prop on
   `<Map>`, so the basemap style itself finishes loading first.
2. Replaced direct `showLanduse`/`showHillshade`/`showTerrainColor`/
   `showContours` → `*Mounted` state wiring with a staggered `readyStage`
   counter (0/1/2/3), advanced via `setTimeout` at 300ms steps once
   `styleLoaded` is true:
   - `readyStage >= 1` unlocks `landuseMounted`
   - `readyStage >= 2` unlocks `hillshadeMounted`
   - `readyStage >= 3` unlocks `contoursMounted`
   A layer that's off doesn't block a later-staged layer that IS on (each
   effect only checks its own show-flag + the stage threshold, not the
   sibling layers' mounted state) — see the long comment right above these
   `useState`/`useEffect` calls (search `readyStage` in the file) for full
   reasoning, already written, don't duplicate it elsewhere.
3. Added bounded auto-retry for JS-catchable map load failures:
   `onDidFailLoadingMap` → `handleMapLoadFailure` → increments
   `mapRetryKey` (forces `<Map key={mapRetryKey}>` remount), capped at
   `MAP_MAX_AUTO_RETRIES = 3` via `mapRetryCountRef`. Camera position is
   preserved across retries via `camStateRef.current` (was previously a
   static `DEFAULT_CENTER`/`DEFAULT_ZOOM` import from `../config` — now
   removed, grep confirmed unused elsewhere).
4. `tsc --noEmit` clean. Two production rebuilds done via
   `apps/native/scripts/build-prod-apk.sh` (background/nohup + poll
   pattern — builds take 3-8 min depending on Gradle daemon state; direct
   foreground bash calls will hit the tool's ~900s timeout).

This fix meaningfully reduces (does not eliminate) the odds of hitting the
ceiling on a normal single cold-start/sign-in.

## Follow-up work done this session

### 1. Staggered other first-mount fetches (DONE)
Surveyed hooks called directly from `src/screens/MapScreen.tsx` that fire
unconditionally on mount and hit the network: `useTraffic` (traffic poll,
70s interval — native uses polling, not SSE, see that hook's own doc
comment for why), `useRegionalNotams`, `useWeatherAlongRoute` (fires an
unconditional `aerodromes.json` fetch on mount, independent of whether a
route is planned), `useWind`.

Added `AviationMap`'s new `onMapReady` prop — fires once, from inside the
existing `readyStage` effect, the same moment `styleLoaded` first flips
true (i.e. the earliest safe point, deliberately BEFORE
`onDidFinishLoadingMap`/full source+layer load, so the map still gets
first claim on bandwidth ahead of these secondary fetches). MapScreen
wires this to a `mapReady` state (never reset false — only delays the
first fetch of each hook's session, doesn't gate every render) and ANDs it
into each hook's own `enabled`/`waypoints` gate:
- `useTraffic({ enabled: layers.traffic && mapReady, ... })`
- `useRegionalNotams(layers.notamCircles && authenticated && mapReady)`
- `useWeatherAlongRoute(waypoints, mapReady)` — added a new optional
  `enabled` param (defaults `true`, so no other call site needed changes)
  gating BOTH its aerodromes-list fetch effect and its per-station wx
  fetch effect.
- `useWind(activePosition, mapReady)` — was previously hardcoded `true`.

`useAircraftSync`/`useRouteSync`/`useUserWaypointSync`/`useFlightLogSync`/
`useAuth` were surveyed but NOT changed — they're owned by context
providers mounted at the app root (`AuthContext`, `UserWaypointContext`,
etc.), above and independent of `MapScreen`/`AviationMap`, so gating them
on `mapReady` isn't a simple prop-thread — it would need either lifting
`mapReady` to the app root (affects every screen, not just the map) or a
different readiness signal entirely. Their payloads are also each
pilot-owned data (aircraft/route/waypoint/log lists), not third-party
bulk archives — lower suspicion than the PMTiles/GeoJSON fetches, and NOT
named in either OOM crash signature from the original investigation. Left
as an open question for a future pass if staggering the four hooks above
turns out insufficient on retest.

`tsc --noEmit` clean after these changes.

### 2. MapLibre Native (Android) memory/cache tuning (RESEARCHED — no change made)
Checked the pinned `@maplibre/maplibre-react-native@^11.3.9` package's own
TS source (not just docs, actual `node_modules` source) for tunable knobs:
- `OfflineManager.setMaximumAmbientCacheSize(bytes)` exists (Android-only,
  default ambient cache 50MB, `0` disables it). This governs the on-disk
  SQLite ambient tile cache, not in-flight request/allocation memory during
  a PMTiles range-request burst — doesn't address either crash signature
  (OOM happened receiving HTTP/2 stream data / during header fetch, before
  anything reaches the ambient cache). Not applied — no evidence it would
  help, and shrinking it is described upstream as "computationally
  expensive" (trims existing DB rows).
- `NetworkManager` in this version exposes exactly one method:
  `setConnected(boolean)` (Android-only network kill-switch for offline
  mode). No `setConnectionPoolSize`/concurrency-limit equivalent exists in
  the current JS API surface — confirmed by reading
  `src/modules/network/NetworkManager.ts` directly, not guessing from
  memory or older-version docs.
- No JS-reachable API for OkHttp connection-pool/max-concurrent-requests
  tuning found. `setOkHttpClient()` exists at the native
  (Kotlin/`HttpRequestImpl`) layer only — would require an Android-native
  patch (Expo config plugin + native module), not a JS-side change; not
  attempted this session given no confirmed payoff and real risk of
  destabilizing an already-fragile release build.
- `android:largeHeap="true"`'s 512MB ceiling: not further investigated —
  OEM `dalvik.vm.heapgrowthlimit`/`heapsize` build.prop values are not an
  app-side lever regardless of what's confirmed, so this doesn't change
  the recommended approach (reduce concurrent peak demand, not chase a
  higher ceiling).

**Conclusion: the staggering approach (item #1, both the original
landuse/hillshade/contours fix and this session's fetch-gating) is the
right lever for this library version — no additional MapLibre-side
tunable was found that meaningfully reduces peak memory during the PMTiles
range-request burst itself.** If OOM still reproduces after retest with
both fixes in place, the next avenue is the native-module
`setOkHttpClient()` path above, or reducing `basemap.pmtiles`/
`landuse.pmtiles`/etc. file sizes themselves (out of scope here).

## Retest session (2026-09-16, this session)

Rebuilt+installed the already-committed fixes (`87eb42d` lazy-mount +
`70043b1` mapReady fetch-gating) fresh via `build-prod-apk.sh`, then ran
the real fresh-sign-in repro on the SM_S918B phone (real OTP, human
approved on-device).

**Crash reproduced again**, new signature: `java.lang.OutOfMemoryError`
thrown on a `binder:*` thread inside `Intent$1.createFromParcel` (not the
OkHttp/okio one from the original investigation — same root cause,
different thread/allocation just happened to be the one that lost the
race this time). Confirmed via full `adb logcat -d -v threadtime`:
`ActivityManager: Process org.openvfr.app ... has died: fg TOP`.

Key evidence pulled from the GC log lines (`Background ... GC freed ...
NMB/NMB`) around the crash: heap climbed **175MB -> 511MB in ~9 seconds**
(11:13:46 -> 11:13:55), i.e. essentially the same fast burst as originally
diagnosed. Only **11** `Mbgl-HttpRequest: ... Canceled` lines this time,
vs. "many" in the original investigation -- the `mapReady`-gated fetch
staggering (item #1 in the original fix) genuinely reduced concurrent
request cancellations, but did nothing for the memory peak itself.

**Root cause of why the fix didn't hold:** the `readyStage` timer steps
were only **300ms / 600ms** apart (see the code comment above the
`readyStage` `useEffect` in `AviationMap.tsx`, now updated). A 100-230MB
PMTiles archive takes several seconds to fetch over a real network --
300ms is nowhere near enough separation, so by the time landuse's
download is still in flight, hillshade's timer has already fired too, and
all three heavy sources' transfers overlap in time regardless. The fixed
timer was staggering *trigger* time, not actual *completion*, so it barely
moved the needle on peak concurrent memory.

**Change made this session:** bumped the `readyStage` steps from
300ms/600ms to **4000ms/8000ms** (`AviationMap.tsx`, same `useEffect`).
Still a fixed timer, not event-driven (doesn't actually wait for the prior
stage's tiles to finish loading) -- a stronger safety margin, not a
structural fix. `tsc --noEmit` clean. Rebuilt + reinstalled.

**Verification status: partial.** The phone (SM_S918B) that reproduced
the crash twice was swapped out mid-session for a tablet (SM_X135F,
different device, already signed in, no known persisted
hillshade/contours state). Cold-start test on the tablet with the new
4000ms/8000ms build: **no crash, no OOM, process stayed alive**, but heap
only peaked at 55MB -- consistent with only basemap+landuse mounting
(hillshade/contours likely off/unset on this fresh device), i.e. a lighter
scenario than the phone's persisted-hillshade+contours case that actually
triggered the OOM both times. **This does NOT yet confirm the harder case
is fixed.**

**Update — confirmed fixed:** phone reconnected later in the same session.
Rebuilt/installed the 4000ms/8000ms build onto the actual SM_S918B
(replacing its stale 300ms/600ms install), ran a full `pm clear` + real
OTP fresh-sign-in repro again. Result: **zero OOM lines, zero crash,
process stayed alive 15s+ post sign-in, heap peaked at only 48MB** (vs.
511MB before). Confirmed on the exact device/repro that reproduced the
crash twice at the old timing. Status: fixed, though still a fixed-timer
safety margin rather than an event-driven guarantee — if a future device
with a slower connection still overlaps the 4s/8s windows, the next lever
remains event-driven staggering (gate each stage on the previous heavy
source's tiles actually finishing, e.g. polling `map.isSourceLoaded` or an
equivalent readiness signal) rather than a bigger constant.

## Unrelated bug found + fixed same session: location-permission Settings bounce

User-reported: every app launch, picking a location-permission option
kicked them into the OS "Location permission" Settings screen, requiring a
manual back-out to return to the app.

Root cause: `MapScreen.tsx`'s mount effect calls `useGps().start()`
unconditionally on every mount (i.e. every app launch/foreground), which
called `locationTask.ts`'s `startBackgroundLocation()`, which
unconditionally called both `Location.requestForegroundPermissionsAsync()`
AND `Location.requestBackgroundPermissionsAsync()` — every single time,
with no check of current permission status first. Android's background-
location permission only shows the real in-app dialog on the FIRST-ever
request; every subsequent request (once status is already settled, granted
OR denied) redirects straight to the OS "Location permission" Settings
screen instead of a dialog. Confirmed via `dumpsys package org.openvfr.app
| grep -A5 "runtime permissions"` — `ACCESS_BACKGROUND_LOCATION` was
already `granted=false` (pilot chose "while using the app" once), so every
subsequent app launch re-triggered the request and bounced to Settings.

Fix (`apps/native/src/tasks/locationTask.ts`, `startBackgroundLocation`):
call `getForegroundPermissionsAsync()`/`getBackgroundPermissionsAsync()`
first and only call the `request*` variant when status is genuinely
`'undetermined'` — never re-request once the pilot has already answered
either way. `tsc --noEmit` clean (pre-existing unrelated errors in
`SettingsScreen.tsx` from other in-progress uncommitted work, not this
change — confirmed via `git stash` isolation).

Verified on-device: rebuilt + force-stop/relaunch on the SM_S918B (which
already had `ACCESS_BACKGROUND_LOCATION: granted=false` from prior runs) —
app now launches straight into the map, no permission dialog, no Settings
redirect. Confirmed via screenshot + `dumpsys` permission state.

## Repro / verification pattern that works
- Device: Samsung SM_S918B, adb id `R5CW143GQFX`.
- Fresh sign-in repro: `adb shell pm clear org.openvfr.app`, launch app,
  complete a REAL passkey/OTP sign-in (adb `input tap` on the passkey
  button triggers a system biometric prompt that auto-cancels without a
  real fingerprint — need the human at the keyboard to actually approve
  it, or use email OTP and read the code from the human).
- Capture full context, not just a grep: `adb logcat -d -v threadtime >
  /tmp/whatever.txt`, then grep for `OutOfMemoryError`, `FATAL EXCEPTION`,
  `has died`, `Mbgl-HttpRequest`. A prior narrower grep (`adb logcat -d -v
  brief | grep ...`) missed the full stack trace and the `ActivityManager:
  ... has died` line that proves it was a real process kill, not just a
  logged warning — use `-v threadtime` and grep broadly, then narrow.
- Build/install: `cd apps/native && nohup bash scripts/build-prod-apk.sh >
  /tmp/build-prod-apkN.log 2>&1 &` then poll with `sleep 180-240; tail -50
  /tmp/build-prod-apkN.log` — do NOT run this in foreground, it exceeds the
  bash tool's timeout.
- adb screenshot path quirk in Git Bash: use `//sdcard//name.png` (double
  leading slashes) for `screencap -p` / `pull` to avoid MSYS path mangling.
