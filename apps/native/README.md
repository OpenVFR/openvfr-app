# open-vfr Mobile

React Native (bare Expo) app — the native companion to the open-vfr PWA.

## Stack

| Concern | Library |
|---|---|
| Framework | Expo SDK 56 (bare workflow — no EAS required) |
| Map engine | `@maplibre/maplibre-react-native` v11 → MapLibre GL Native |
| Basemap | OpenFreeMap (free, no API key, ODbL) |
| Aviation data | GeoJSON served from the open-vfr web/API server |
| Auth | `better-auth` v1.6 + `@better-auth/passkey` |
| Storage | `@react-native-async-storage/async-storage` |
| GPS | `expo-location` |
| Navigation | React Navigation v7 (bottom tabs) |

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node | 22+ | JS toolchain |
| pnpm | 11+ (via corepack) | Package manager |
| Android Studio | 2024+ | Android SDK + build tools |
| Java (JDK) | 17 | Gradle builds |

> **iOS:** Xcode 16+ required; macOS only. All instructions below are Android-focused.

## Important: standalone workspace

`native/` is a **standalone pnpm workspace** — it is intentionally excluded from the
root `pnpm-workspace.yaml`. Do not add it back. Reasons:

- Metro's workspace-root detection hijacks module resolution when nested inside a
  larger workspace, causing "unable to resolve module" errors at runtime.
- The root workspace uses a virtual store (`node_modules/.pnpm`) with symlinks;
  Metro on Windows cannot follow those symlinks reliably.

`native/pnpm-workspace.yaml` pins `nodeLinker: hoisted` so `node_modules/` is a flat
real-directory tree — required for Metro on Windows.

## First-time setup

```bash
cd native
pnpm install

# Create Android SDK path (Windows — edit path if your SDK is elsewhere)
echo "sdk.dir=C\:\\Users\\YOUR_USERNAME\\AppData\\Local\\Android\\Sdk" > android/local.properties

# Generate / update the android/ native project after package changes
npx expo prebuild --platform android
```

> **Re-run `expo prebuild`** whenever you add a package with a native config plugin
> (anything listed under `plugins` in `app.json`).

## Running on a physical Android device

### 1. Enable USB debugging on the device

Settings → About → tap Build Number 7× → Developer Options → USB Debugging ON.

### 2. Connect via USB and verify

```bash
adb devices
# Should show: R8YYA0MNQDD   device   (or your serial)
```

If the device shows `unauthorized`, accept the prompt on the device screen.

### 3. Open the Metro tunnel

Metro must stay running in a dedicated terminal. Run this **once per session**:

```bash
cd native
adb reverse tcp:8081 tcp:8081   # Metro
adb reverse tcp:5200 tcp:5200   # API server
adb reverse tcp:5174 tcp:5174   # Vite (serves public/tiles/*.geojson)
npx expo start --port 8081 --clear
```

`adb reverse` is needed because physical devices cannot reach `localhost` on the
host machine — the tunnel maps the device's `localhost:8081` to your machine's
`localhost:8081` over USB. Re-run after every USB reconnect.

### 4. Build and install the APK

```bash
cd native
pnpm build:android:device
```

Full Gradle build (2–5 min) + APK install + Metro start.

**Only needed when native code changes:**
- First time / clean checkout
- After adding a package with native modules
- After changing `app.json` plugins
- After running `expo prebuild`

### 5. Start Metro (all other sessions)

APK already installed — just start Metro pointed at the right server:

```bash
pnpm metro:local   # → http://localhost:5200 (local Docker stack)
pnpm metro:prod    # → whatever EXPO_PUBLIC_API_BASE / EXPO_PUBLIC_TILE_BASE
                   #   are set to in your own environment or .env file
```

`metro:local` tunnels `adb reverse`, restarts Metro with `--clear`, and
injects `EXPO_PUBLIC_API_BASE=http://localhost:5200` /
`EXPO_PUBLIC_TILE_BASE=http://localhost:5174/tiles` via `cross-env` — no
`.env` file editing required (`config.ts`'s tile URL builders append no
path segment of their own — TILE_BASE must already include whatever path
the host needs; local dev's Vite server serves files under `/tiles/*`,
so the `/tiles` suffix is baked into this value here). `metro:prod` reads
whatever you've set in your own `.env` (see below) — for real production,
set `EXPO_PUBLIC_API_BASE=https://api.example.org` and
`EXPO_PUBLIC_TILE_BASE=https://tiles.example.org` (bare domain, **no**
`/tiles` suffix if your tile host serves files at its root — see
docs/self-hosting.md).

> **Env vars are baked in at bundle time.** Metro does not watch `.env` files.
> Always use `metro:local` / `metro:prod` (which include `--clear`) rather
> than plain `npx expo start` when switching targets.

### 6. Reload after JS-only changes

Metro hot-reloads automatically. For a full reload:

```bash
adb -s R8YYA0MNQDD shell input keyevent 82   # open dev menu → Reload
```

Or press `r` in the Metro terminal.

### Windows-specific notes

- **CRLF line endings** in shell scripts: run with `tr -d '\r' < script.sh | bash`.
- **Path length / native build failures** (`ninja: error: manifest 'build.ninja'
  still dirty after 100 tries`, or CMake `CMAKE_OBJECT_PATH_MAX` warnings): Windows'
  260-char path limit interacts badly with pnpm's `node_modules/.pnpm/<pkg>@<version>_<hash>/...`
  layout on a deeply nested checkout. Things to try, in order:
  1. Enable long paths (`HKLM\SYSTEM\...\FileSystem\LongPathsEnabled = 1`,
     or Group Policy) -- necessary but often not sufficient on its own.
  2. Shorten pnpm's virtual store path for your own local checkout only
     (**do not commit this** -- it's an absolute, machine-specific path
     that would break Linux CI and any other Windows dev without the same
     drive letter): add `virtualStoreDir: D:/vs` (or similar, any short
     absolute path outside the project tree) to your local
     `pnpm-workspace.yaml`, then `pnpm install` again. Shaves ~30 chars off
     every nested dependency path.
  3. Point `GRADLE_USER_HOME` at the same drive as the project (e.g.
     `D:/gradle-home`) if you see "Hard link ... failed. Doing a slower
     copy instead." in the build log -- Gradle's cache defaulting to `C:`
     while the project lives on `D:` means every native module's prefab
     `.so` copy crosses volumes, which can never hardlink.
  4. **Check your bundled ninja version**: `<Android SDK>/cmake/<version>/bin/ninja.exe --version`.
     Anything below `1.12.0` has a confirmed long-path handling bug (see
     [ninja#1900](https://github.com/ninja-build/ninja/issues/1900), and
     [reanimated's own Windows build guide](https://docs.swmansion.com/react-native-reanimated/docs/guides/building-on-windows/)
     calls this out explicitly). Download a current release from
     [ninja-build/ninja releases](https://github.com/ninja-build/ninja/releases)
     and replace the SDK's copy in place (back up the original first). This
     was the actual root cause the one time all of the above still wasn't
     enough -- the symptom was a *different* native module failing on each
     retry with the identical error, which is the signature of a marginal
     long-path bug rather than a deterministic config problem.
  5. As a last resort, keep the project path itself short (e.g. `C:\ov\`) or
     `subst` a short drive letter -- but note `subst` can itself break Kotlin's
     incremental compiler ("this and base files have different roots") since
     it canonicalizes symlinks back through the real path, so prefer options
     2-4 first.
- **Metro cache** lives at `%LOCALAPPDATA%\Temp\metro-cache`. Clear it if you see
  stale bundle errors: `npx expo start --clear`.

## Server / API configuration

Aviation data and auth are served by the open-vfr server. The app resolves the URL
from environment variables.

### Environment files (both gitignored)

| File | Purpose |
|---|---|
| `native/.env` | Default — set this to your own deployed production API/tile host |
| `native/.env.local` | Local override — takes precedence over `.env` |

### Local development (physical device)

`native/.env.local` (created automatically — edit if your LAN IP changes):

```dotenv
EXPO_PUBLIC_API_BASE=http://<your-lan-ip>:5173
```

Find your LAN IP: `ipconfig` → Wi-Fi adapter → IPv4 Address.

Start the server from the repo root:

```bash
# From repo root:
pnpm dev        # Vite dev server on :5173
# or
docker compose up
```

The server needs these env vars in the root `.env`:

```dotenv
BETTER_AUTH_SECRET=<32+ char secret>
BETTER_AUTH_URL=http://<your-lan-ip>:5173
BETTER_AUTH_APP_ORIGIN=http://<your-lan-ip>:5173
```

In dev, OTP codes are printed to the **server console** — no email is sent.

### Testing against production

Delete or rename `native/.env.local`. The app falls back to `native/.env` —
set this to your own deployed production API/tile host. Restart Metro.

### Switching summary

| Target | Command | Metro needed? |
|---|---|---|
| Local dev (JS live reload) | `pnpm metro:local` | Yes — local Docker stack |
| Prod dev (JS live reload) | `pnpm metro:prod` | Yes — Metro on your machine |
| Standalone prod (no Metro) | `pnpm build:apk:prod` | No — bundle baked into APK |

`cross-env` injects the URLs directly into the Metro process — takes
precedence over `.env.local` so no file editing or deletion required.
Metro restarts with `--clear` on every switch to flush the module cache.

`adb reverse` for ports 5200 and 5174 is only wired into `metro:local`
(production uses HTTPS, no tunnelling needed).

### URL resolution logic (`src/config.ts`)

```
EXPO_PUBLIC_API_BASE env var (from .env / .env.local)
  → EXPO_PUBLIC_API_BASE_ANDROID env var (Android-specific override)
    → http://localhost:5200      (Android: via `adb reverse tcp:5200 tcp:5200`)
    → http://localhost:5200      (iOS simulator / web)
```

## Auth

Auth uses `better-auth` with email OTP (primary) and passkeys (secondary).

- **`better-auth/client/plugins`** — exports `emailOTPClient` only. Passkey client
  is a **separate package**: `@better-auth/passkey/client`.
- **No `bearerClient`** — does not exist as a client plugin. Bearer tokens are
  handled automatically by the `storage` adapter in `authClient.ts`.
- React Native `fetch` omits the `Origin` header; `authClient.ts` injects it via
  `fetchOptions.headers.Origin` so better-auth's CSRF check passes.

The server's `trustedOrigins` (in `apps/api/src/auth.ts`) includes (dev only):
- `http://localhost:5200` / `:5174` / `:5173`
- `http://10.0.2.2:5200` / `:5173` (Android emulator loopback)
- Any LAN origins via `BETTER_AUTH_DEV_LAN_ORIGINS` (comma-separated, e.g. `http://<your-lan-ip>:5173`)

In production only `BETTER_AUTH_APP_ORIGIN` + `BETTER_AUTH_TRUSTED_ORIGINS` are trusted.

## Debugging

### Logs

All auth actions log to Metro terminal / logcat under `ReactNativeJS`:

```bash
adb -s R8YYA0MNQDD logcat -s ReactNativeJS
```

Useful logcat one-liners:

```bash
# Tail JS logs only
adb logcat -s ReactNativeJS

# Clear logcat then restart app and capture everything
adb logcat -c
adb shell am force-stop org.openvfr.app && am start -n org.openvfr.app/.MainActivity
sleep 10 && adb logcat -d | grep ReactNativeJS
```

### Clear Metro cache

```bash
npx expo start --port 8081 --clear
```

### Force reinstall APK

```bash
adb uninstall org.openvfr.app
pnpm build:android:device
```

## Project structure

```
native/
├── app.json              Expo config (bundle ID, permissions, plugins)
├── app.config.js         Layers EAS_PROJECT_ID / EAS_OWNER env vars onto app.json
│                         (run `eas init`, then export both — see file header)
├── package.json          Dependencies + scripts
├── pnpm-workspace.yaml   nodeLinker: hoisted (required for Metro on Windows)
├── tsconfig.json         TypeScript config
├── babel.config.js       Babel (expo preset + module-resolver @→./src)
├── metro.config.js       Metro config (adds .geojson to assetExts)
├── index.js              Entry point (registerRootComponent)
├── .env                  Gitignored — production API base URL
├── .env.local            Gitignored — local dev override (create manually)
└── src/
    ├── App.tsx           Root component
    ├── config.ts         API base URL, tile URLs, map defaults
    ├── navigation/
    │   └── index.tsx     Tab navigator
    ├── screens/
    │   ├── LoginScreen.tsx     Email OTP + passkey sign-in
    │   ├── MapScreen.tsx       Full-screen map + GPS instruments
    │   ├── PlanScreen.tsx      Route planning
    │   └── SettingsScreen.tsx  Preferences
    ├── components/
    │   ├── AviationMap.tsx     MapLibre RN map (v11 API)
    │   └── GpsInstruments.tsx  Speed/altitude/track HUD
    ├── hooks/
    │   ├── useAuth.ts      Auth state, sendOtp, verifyOtp, passkey
    │   ├── useGps.ts       expo-location → GpsPosition
    │   ├── useRoute.ts     Route state + persistence
    │   └── useSettings.ts  Settings state + persistence
    └── utils/
        ├── authClient.ts   better-auth client (emailOTP + passkey plugins)
        ├── routeCalc.ts    Great-circle distance, magnetic bearing
        ├── units.ts        NM/km, kts/km·h⁻¹ conversions
        ├── fuelCalc.ts     Fuel plan calculator
        └── sunCalc.ts      Sunrise/sunset calculator
```

## Barometric altitude & vario

Altitude source priority (`src/hooks/useAltitudeSource.ts`, pure logic in
`packages/shared/src/baroAltitude.ts`): BlueFly Vario (BLE) > phone barometer > GPS.

**Phone barometer** (`expo-sensors`, opt-in via `useInternalBarometer`):

- First run: `BaroPromptModal` offers it once, only if the sensor is present.
  Any answer, or touching the Settings toggle, sets `baroPromptSeen`, so the
  prompt never returns. Turning it off later is respected.
- Vertical speed comes from `PhoneVarioFilter` (`packages/shared/src/phoneVario.ts`),
  a Kalman filter tuned for a ~1 Hz phone sensor. It always works against ISA
  1013.25 hPa so QNH changes never appear as a VS spike. Tuning knobs:
  `PHONE_POSITION_NOISE`, `PHONE_ACCEL_NOISE`.
- iOS: reading the sensor triggers the system "Motion & Fitness" prompt
  (`NSMotionUsageDescription`, set via the `expo-sensors` plugin in `app.json`).
  The data is used on-device only and is not sent anywhere.
- Android: no runtime permission is needed. `expo-sensors` also declares
  `ACTIVITY_RECOGNITION` (pedometer only); `app.json` blocks it.

**QNH** (`packages/shared/src/qnhResolve.ts`), in auto mode:

1. Interpolated METAR QNH of nearby aerodromes (`useNearestQnh`). Values outside
   940–1080 hPa are rejected; a result older than 3 h or more than 100 NM away
   is dropped when no fresh METAR is available.
2. Field calibration (`useFieldQnh`, `packages/shared/src/fieldQnh.ts`): while parked
   (≤ 3 kt) within 1 NM of an aerodrome, QNH is derived from the pressure and the
   published field elevation.
3. Otherwise the stored value is used and the P.ALT gauge shows `?` (uncalibrated).

Manual QNH mode always uses the stored value. The live QNH is also published to the
BlueFly pipeline (`VarioContext.setLiveQnh`), and the BlueFly filter restarts if QNH
steps by more than 0.5 hPa so the step is not read as a climb.

The phone barometer is advisory: cabin pressure, vents and pocket/case placement
affect it.

## MapLibre v11 API notes

`@maplibre/maplibre-react-native` v11 made breaking changes:

- **No default export** — use named imports: `import { MapView, Camera, ... } from ...`
- **No `setAccessToken`** — removed; pass `attribution={false}` to suppress the nag
- **`mapStyle`** replaces `styleURL`
- **`minzoom`** replaces `minZoomLevel` on `<Layer>`
- **`<UserLocation />`** replaces `<MapboxGL.UserLocation />`

See `src/components/AviationMap.tsx` for the reference implementation.

## Offline tiles (Phase 6)

Not yet implemented. Planned:

- MapLibre Native `OfflineManager` for basemap tile caching
- `expo-file-system` to cache GeoJSON aviation data
- SQLite adapter to replace AsyncStorage for flight logs and tracks
