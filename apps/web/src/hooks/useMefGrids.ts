/**
 * useMefGrids (web) — the active countries' grid-maximum-elevation files
 * (`<cc>-mef.mef`, a few MB, see @open-vfr/shared/mefGrid) for the offline
 * corridor-maximum MSA. A missing file (pipeline not run yet / offline and
 * uncached) simply yields no grid: MSA then uses the centreline samples only.
 */
import { useEffect, useState } from 'react'
import { loadMefGrids, type MefGrid } from '@open-vfr/shared/mefGrid'
import { countryMefFile } from '@open-vfr/shared/countryData'
import { versionedTileUrlReady, onTileManifestChanged } from '@open-vfr/shared/tileManifest'
import { useActiveCountries } from '../utils/countryData'
import { TILES_BASE_URL } from '../utils/env'

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

export function useMefGrids(): MefGrid[] {
  const { countries, key } = useActiveCountries()
  const [grids, setGrids] = useState<MefGrid[]>([])
  // A manifest change (new data, or the first manifest after an unversioned fallback) reloads with the new URLs.
  const [manifestTick, setManifestTick] = useState(0)
  useEffect(() => onTileManifestChanged(() => setManifestTick(t => t + 1)), [])
  useEffect(() => {
    let alive = true
    // Versioned URLs only: wait for the tile manifest (bounded) before building them.
    void Promise.all(countries.map(c => versionedTileUrlReady(TILES_BASE_URL, countryMefFile(c)))).then((urls) => {
      if (!alive) return
      const sources = urls.map(url => ({ key: url, load: () => fetchBytes(url) }))
      return loadMefGrids(sources).then((g) => { if (alive) setGrids(g) })
    })
    return () => { alive = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, manifestTick])
  return grids
}
