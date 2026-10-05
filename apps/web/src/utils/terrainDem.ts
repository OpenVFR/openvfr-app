/**
 * terrainDem (web) — ground-elevation lookup from the hosted
 * `se-hillshade.pmtiles` via HTTP Range requests, as the fallback when the
 * elevation API is down. pmtiles' FetchSource refuses a 200 response whose
 * Content-Length exceeds the requested range, so a host that ignores Range
 * can never stream the whole archive into memory (see AGENTS.md).
 */

import { FetchSource } from 'pmtiles'
import { PmtilesDem } from '@open-vfr/shared/terrainDem'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'
import { TILES_BASE_URL } from './env'

let _dem: { url: string; dem: PmtilesDem } | null = null

export function getRemoteDem(): PmtilesDem {
  const url = versionedTileUrl(TILES_BASE_URL, 'se-hillshade.pmtiles')
  if (_dem?.url !== url) _dem = { url, dem: new PmtilesDem(new FetchSource(url)) }
  return _dem.dem
}
