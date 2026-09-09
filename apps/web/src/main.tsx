import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { loadTileManifest } from '@open-vfr/shared/tileManifest'
import { TILES_BASE_URL } from './utils/env'
import './index.css'
import App from './App.tsx'

// Fire-and-forget -- fast (a few KB), and every consumer of
// versionedTileUrl() degrades gracefully to an unversioned URL if called
// before this resolves, so there's no need to block first render on it.
void loadTileManifest(TILES_BASE_URL)
// Suppress the RxDB free-tier promotional log that fires on every DB open.
// The message is printed unconditionally by getRxStorageDexie and is not an error.
const _origLog = console.log
console.log = (...args: unknown[]) => {
  const first = String(args[0] ?? '')
  if (first.includes('RxDB Open Core') || first.includes('rxdb.info/premium')) return
  _origLog.apply(console, args)
}
// Register the PMTiles protocol once at app bootstrap.
// This allows MapLibre to resolve any source URL prefixed with "pmtiles://"
// by reading directly from a .pmtiles archive via HTTP Range requests —
// no tile server required.
const protocol = new Protocol()

// Key extraction mirrors pmtiles' own Protocol.tilev4 (dist/esm/index.js):
// tile requests are "pmtiles://<archiveUrl>/{z}/{x}/{y}", header/style-source
// requests are "pmtiles://<archiveUrl>" verbatim. Must match exactly so we
// evict the same Map key the library used internally.
function pmtilesArchiveKey(url: string): string {
  const tileMatch = url.match(/^pmtiles:\/\/(.+)\/\d+\/\d+\/\d+$/)
  return tileMatch ? tileMatch[1] : url.slice('pmtiles://'.length)
}

// pmtiles' Protocol caches the archive header fetch in a per-URL
// SharedPromiseCache that is only invalidated on an EtagMismatch — a
// transient failure on the very first header fetch (dev-server race, CDN
// blip, the "Wrong magic number" case MapView.tsx already swallows) leaves
// that promise permanently rejected for the lifetime of the page. Every
// subsequent request for that archive fails forever, and the basemap never
// appears until a full reload creates a fresh Protocol/cache. Wrap the
// protocol so a failed request evicts the poisoned PMTiles instance and
// retries once, self-healing the transient case instead of requiring a
// manual refresh.
maplibregl.addProtocol('pmtiles', async (params, abortController) => {
  try {
    return await protocol.tile(params, abortController)
  } catch (err) {
    protocol.tiles.delete(pmtilesArchiveKey(params.url))
    return protocol.tile(params, abortController)
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
