import { registerRootComponent } from 'expo'
import {
  loadTileManifest, refreshTileManifest, enableTileManifestPersistence, isTileManifestFromStorage, getCachedTileManifest,
} from '@open-vfr/shared/tileManifest'
import AsyncStorage from '@react-native-async-storage/async-storage'
// Imported for their side effect first: they register the caches restored below.
import '@open-vfr/shared/fetchWind'
import '@open-vfr/shared/windForecast'
import { enableCachePersistence } from '@open-vfr/shared/persistedCache'
import { setApiAuthHeaders } from '@open-vfr/shared/apiAuth'
import { authHeaders } from './src/utils/authClient'
import { Platform, AppState } from 'react-native'
import * as Application from 'expo-application'
import { initGpsAltitudeReference } from '@open-vfr/shared/gpsAltitudeReference'
import { TILE_BASE } from './src/config'
import App from './src/App'
// Must be imported here (unconditionally, at startup) so expo-task-manager's
// background location task is defined before any headless relaunch by the OS.
import './src/tasks/locationTask'

// BUG FIX: native was the only platform never calling loadTileManifest(),
// so every static tile/GeoJSON URL (config.ts's TILE_URLS + *_PMTILES_URL)
// was permanently unversioned -- a CDN/OkHttp cache entry for e.g.
// se-obstacles.geojson could keep serving stale bytes indefinitely after a
// real data refresh, with no way to bust it (web's equivalent fetches all
// go through versionedTileUrl(), which appends a content-hash query string
// from this same manifest.json -- see @open-vfr/shared/tileManifest's own
// header comment). Kicked off here, mirroring web's main.tsx, as early as
// possible and before any tile fetch -- config.ts's getTileUrls()/
// get*PmtilesUrl() helpers read the resulting cached manifest lazily at
// first use, same graceful-degrade-to-unversioned-URL behavior as web when
// this hasn't resolved yet (offline first launch, etc.).
// The last manifest is kept on the device: an offline start uses it, so the
// map asks for the same versioned URLs its cache holds instead of unversioned
// ones it never fetched (blank map after a restart in flight).
enableTileManifestPersistence(AsyncStorage)
void loadTileManifest(TILE_BASE)
// No fresh manifest yet (started offline on the stored copy, or with none at
// all, e.g. a first start offline): fetch one each time the app comes to the
// foreground until one arrives. No timer, no background work.
AppState.addEventListener('change', (state) => {
  if (state === 'active' && (!getCachedTileManifest() || isTileManifestFromStorage())) void refreshTileManifest(TILE_BASE)
})
// Wind readings survive an app restart, so a restart doesn't refetch them
// from the rate-limited Open-Meteo API (see @open-vfr/shared/persistedCache).
void enableCachePersistence(AsyncStorage)
// Shared fetch code without its own headers parameter (Open-Meteo gate,
// terrain profile) authenticates with the bearer token: RN has no cookie jar.
setApiAuthHeaders(authHeaders)
// GPS altitude reference of expo-location's `next` `altitude` field: the
// ellipsoid on both platforms (the OS's own sea-level value arrives separately
// as `mslAltitude`). Verified on the ground and re-checked after an OS or app update -- see
// @open-vfr/shared/gpsAltitudeReference.
void initGpsAltitudeReference({
  platformDefault: 'ellipsoid',
  environment: `${Platform.OS} ${Platform.Version} app ${Application.nativeApplicationVersion ?? '?'} (${Application.nativeBuildVersion ?? '?'})`,
  store: AsyncStorage,
})

// Deliberately NOT also polling in the background here (unlike web's
// TileUpdatePrompt.tsx) -- a native cold-start already re-runs this file
// fresh on every launch, and mobile OSes routinely suspend/kill backgrounded
// apps under memory pressure (this app has real documented OOM exposure,
// see AGENTS.md's MapLibre RN gotchas), so a native session naturally gets
// a fresh manifest far more often than a browser tab that can stay open for
// days uninterrupted. The remaining long-foregrounded-session case is
// already covered without any new code: SettingsScreen.tsx's
// OfflineDataSection already calls refreshTileManifest() on every Settings-
// screen focus (originally added to keep its offline-cache staleness badges
// accurate) -- app-start + "open Settings" is an adequate manual-check path
// given this app has no reload mechanism yet anyway (expo-updates/OTA would
// be needed to act on a change even if detected sooner -- a bigger decision
// than this fix's scope).

registerRootComponent(App)
