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

registerRootComponent(App)
