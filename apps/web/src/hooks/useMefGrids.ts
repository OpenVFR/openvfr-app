/**
 * useMefGrids (web) — the active countries' grid-maximum-elevation files
 * (`<cc>-mef.mef`, a few MB, see @open-vfr/shared/mefGrid) for the offline
 * corridor-maximum MSA. A missing file (pipeline not run yet / offline and
 * uncached) simply yields no grid: MSA then uses the centreline samples only.
 */
import { useEffect, useState } from 'react'
import { loadMefGrids, type MefGrid } from '@open-vfr/shared/mefGrid'
import { countryMefFile } from '@open-vfr/shared/countryData'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'
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
  useEffect(() => {
    let alive = true
    const sources = countries.map((c) => {
      const url = versionedTileUrl(TILES_BASE_URL, countryMefFile(c))
      return { key: url, load: () => fetchBytes(url) }
    })
    loadMefGrids(sources).then((g) => { if (alive) setGrids(g) })
    return () => { alive = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return grids
}
