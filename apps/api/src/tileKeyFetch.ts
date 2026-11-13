/**
 * Adds the tile host key (TILES_KEY, sent as `?ovk=`) to every server-side
 * fetch of a URL under TILES_BASE_URL: the manifest and file checks
 * (pipeline.ts), briefing data and MEF grids (briefingData.ts), terrain
 * archives (demElevation.ts), weather grids (wxGrid.ts) and chart indexes
 * (chartDocuments.ts). One wrapper instead of a helper at each call site, so a
 * new fetch can't forget it; other URLs pass through untouched.
 *
 * A tile host that only serves its own clients lets browsers in by Origin;
 * this server sends none, so it needs the key. Unset = nothing installed.
 * See packages/shared/src/tileKey.ts.
 *
 * Imported for its side effect as the FIRST import of index.ts, so the
 * wrapper is in place before any module runs.
 */
import { installTileKeyFetch, parseTileKey } from '@open-vfr/shared/tileKey'

const base = (process.env['TILES_BASE_URL'] ?? '').trim()
const key = parseTileKey(process.env['TILES_KEY'], (m) => console.warn(`[tiles] ${m}`))

if (installTileKeyFetch(globalThis, key, [base])) {
  console.log('[tiles] access key added to tile host requests')
} else if (key && !/^https?:\/\//i.test(base)) {
  console.warn('[tiles] TILES_KEY is set but TILES_BASE_URL is not an http(s) URL: key not used')
}
