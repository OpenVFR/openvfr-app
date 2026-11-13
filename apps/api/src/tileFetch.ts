/**
 * Headers for the api's own requests to the tile host (TILES_BASE_URL: datasets, manifest, charts indexes, grids). The api runs in a
 * datacenter: an anonymous request without a user agent looks like a bot to the tile host's edge, which may answer 403. Every other
 * outbound request of the api already names itself the same way.
 */
export const TILE_FETCH_HEADERS: Record<string, string> = { 'User-Agent': 'open-vfr/1.0 (api)' }
