import { registerRootComponent } from 'expo'
import { loadTileManifest } from '@open-vfr/shared/tileManifest'
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
