import { registerRootComponent } from 'expo'
import { loadTileManifest, startTileManifestPolling } from '@open-vfr/shared/tileManifest'
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
void loadTileManifest(TILE_BASE)

// Refreshes the cached manifest every 15min for the life of the JS engine
// (same mechanism/interval as web's TileUpdatePrompt.tsx) so a long-
// foregrounded session doesn't stay pinned to launch-time tile hashes
// forever. Unlike web, this does NOT yet notify the user or trigger a
// reload on an actual change (onTileManifestChanged() is available from the
// same module if/when that's wanted) -- there is no expo-updates/OTA-reload
// mechanism in this app today, and adding one is a bigger decision (release
// channels, rollout policy) than this fix's scope. Practical impact today:
// a real data update becomes visible on the next natural remount (app
// backgrounded far enough to be killed and relaunched, which calls
// loadTileManifest() fresh via this same file) rather than needing that;
// still relies on SOME remount for a still-running, never-backgrounded
// session, same residual risk web had before its fix.
startTileManifestPolling(TILE_BASE)

registerRootComponent(App)
