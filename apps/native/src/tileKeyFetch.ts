/**
 * Adds the tile host key (config.ts TILE_KEY, `?ovk=`) to every JS fetch()
 * of a URL under TILE_BASE: manifest.json, country files read in JS, the
 * shared package's own fetches. One wrapper instead of a helper at each call
 * site, so a new fetch can't forget it. URLs for MapLibre and the native
 * downloader are keyed where they are built (config.ts tileFileUrl), because
 * those requests never pass through JS fetch.
 *
 * Imported for its side effect by index.js, right after `expo` (which sets up
 * the runtime globals) and before anything that fetches. No key = nothing
 * is installed.
 */
import { installTileKeyFetch } from '@open-vfr/shared/tileKey'
import { TILE_BASE, TILE_KEY } from './config'

installTileKeyFetch(globalThis as unknown as { fetch: typeof fetch }, TILE_KEY, [TILE_BASE])
