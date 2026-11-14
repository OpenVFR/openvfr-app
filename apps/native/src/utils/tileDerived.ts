/**
 * Data derived from one of the active country's tile files (an aerodrome list,
 * airspace polygons, ...), cached per versioned URL.
 *
 * Replaces the per-hook "module cache + loading flag + listeners" pattern,
 * which had two problems once URLs became versioned: a reset on a manifest
 * change could not stop a load already in flight (an unversioned response
 * could land in the cache after the reset), and mounted hooks never loaded
 * again after a reset. Here the cached result belongs to the URL it was
 * loaded from: a new file version or another country is a new URL and so a
 * new load, an unchanged file keeps its result (no refetch of every dataset
 * when one file changes), and a late result of an older URL is never handed
 * out for the current one. Hooks re-run their load on `useTileDataTick()`.
 */
import { useEffect, useState } from 'react'
import { tileUrlReady, onTileDataChange, type TileKey } from '../config'
import { loadGeoJsonOnce } from './geoJsonCache'

export function createTileDerived<T>(key: TileKey, derive: (fc: GeoJSON.FeatureCollection) => T): () => Promise<T> {
  let cur: { url: string; p: Promise<T> } | null = null
  return async () => {
    const url = await tileUrlReady(key)
    if (!cur || cur.url !== url) {
      const mine = { url, p: loadGeoJsonOnce(url).then(derive) }
      cur = mine
      mine.p.catch(() => { if (cur === mine) cur = null })        // a failed load is retried next time
    }
    return cur.p
  }
}

/** Ticks when data loaded earlier may be outdated (country or manifest change): put it in a load effect's deps. */
export function useTileDataTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => onTileDataChange(() => setTick(t => t + 1)), [])
  return tick
}

/** Loads with `load` on mount and on every data tick; a result of an earlier run is dropped. */
export function useTileDerived<T>(load: () => Promise<T>, enabled = true): T | null {
  const tick = useTileDataTick()
  const [value, setValue] = useState<T | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    load().then((v) => { if (alive) setValue(v) }).catch(() => { /* offline-safe: keep what we have */ })
    return () => { alive = false }
  }, [tick, enabled, load])
  return value
}
