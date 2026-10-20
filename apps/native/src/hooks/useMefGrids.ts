/**
 * useMefGrids (native) — the active country's grid-maximum-elevation file
 * (`<cc>-mef.mef`, a few MB, see @open-vfr/shared/mefGrid) for the offline
 * corridor-maximum MSA. Read from the offline cache when downloaded, else
 * fetched (versioned remote URL). Small enough for fetch(); unlike the large
 * pmtiles archives it is never read in ranges. A missing file yields no grid,
 * so MSA falls back to the centreline samples only.
 */
import { useEffect, useState } from 'react'
import { loadMefGrids, type MefGrid } from '@open-vfr/shared/mefGrid'
import { onActiveCountriesChange } from '@open-vfr/shared/countryData'
import { OFFLINE_ASSETS, resolveUri } from '../utils/offlineCache'

async function fetchBytes(uri: string): Promise<Uint8Array> {
  const res = await fetch(uri)
  if (!res.ok && !uri.startsWith('file:')) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

export function useMefGrids(): MefGrid[] {
  const [grids, setGrids] = useState<MefGrid[]>([])
  const [tick, setTick] = useState(0)
  useEffect(() => onActiveCountriesChange(() => setTick((t) => t + 1)), [])
  useEffect(() => {
    let alive = true
    const asset = OFFLINE_ASSETS.find((a) => a.key === 'mef')
    if (!asset) return
    const uri = resolveUri(asset)
    loadMefGrids([{ key: uri, load: () => fetchBytes(uri) }]).then((g) => { if (alive) setGrids(g) })
    return () => { alive = false }
  }, [tick])
  return grids
}
