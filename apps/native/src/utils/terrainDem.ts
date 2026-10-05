/**
 * terrainDem (native) — offline ground-elevation lookup from the cached
 * `se-hillshade.pmtiles` (Copernicus GLO-30, Terrarium PNG). Used as the
 * fallback for the OpenTopoData elevation API by the vertical profile
 * (terrain, MSA, AGL airspace bands) and the live AGL / AGL-limit lookup.
 *
 * Reads ONLY from the local offline-cache file through `File.open()` ranged
 * reads -- never over the network. React Native's `fetch()` buffers whole
 * response bodies in the Java heap, which is exactly how the earlier PMTiles
 * OutOfMemoryErrors happened (see AGENTS.md), so an un-cached archive simply
 * means "no offline terrain" here. Each read is one directory slice or one
 * ~130 KB tile; decoded tiles live in a 6-entry LRU inside PmtilesDem.
 */

import { File } from 'expo-file-system'
import { PmtilesDem, type RangeSource } from '@open-vfr/shared/terrainDem'
import { OFFLINE_ASSETS, isCached, localUriFor } from './offlineCache'

let _dem: { key: string; dem: PmtilesDem } | null = null

function fileRangeSource(file: File): RangeSource {
  return {
    getKey: () => file.uri,
    async getBytes(offset, length) {
      const size = file.size ?? 0
      if (offset >= size) return { data: new ArrayBuffer(0) }
      const handle = file.open()
      try {
        handle.offset = offset
        const bytes = handle.readBytes(Math.min(length, size - offset))
        return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
      } finally {
        handle.close()
      }
    },
  }
}

/** The offline DEM when the hillshade archive is downloaded and non-empty,
 *  else null. Re-created if the cached file changes (re-download). */
export function getOfflineDem(): PmtilesDem | null {
  const asset = OFFLINE_ASSETS.find(a => a.key === 'hillshade')
  if (!asset || !isCached(asset)) { _dem = null; return null }
  const file = new File(localUriFor(asset))
  const key = `${file.uri}|${file.size ?? 0}|${file.modificationTime ?? 0}`
  if (_dem?.key !== key) _dem = { key, dem: new PmtilesDem(fileRangeSource(file)) }
  return _dem.dem
}
