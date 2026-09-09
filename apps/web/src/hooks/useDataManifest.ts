import { useEffect, useRef, useState } from 'react'
import { TILES_BASE_URL } from '../utils/env'
import {
  loadTileManifest,
  refreshTileManifest,
  getCachedTileManifest,
  type TileManifest,
  type TileManifestDataset,
  type TileManifestFileEntry,
} from '@open-vfr/shared/tileManifest'

const LS_KEY = 'ovfr:manifest:seen_at'

// Re-exported for existing consumers of this hook's types -- the manifest
// itself is now fetched/cached by @open-vfr/shared/tileManifest (shared
// with native, and with versionedTileUrl()'s cache-busting), not fetched independently
// here anymore. This hook is now a thin React wrapper around that shared
// cache for the update-banner UI specifically.
export type DataManifestDataset = TileManifestDataset
export type DataManifestFileEntry = TileManifestFileEntry
export type DataManifest = TileManifest

export interface UseDataManifestResult {
  manifest: DataManifest | null
  hasUpdate: boolean
  /** True while a manual refresh fetch is in flight. */
  checking: boolean
  markSeen: () => void
  /** Re-fetch manifest.json immediately (e.g. after user taps "Check for updates"). */
  refresh: () => void
}

/**
 * On mount, reads the shared tileManifest cache (populated at app bootstrap
 * by main.tsx's loadTileManifest() call -- see @open-vfr/shared/tileManifest)
 * and compares manifest.generated_at against the last-seen value stored in
 * localStorage.
 *
 * If the manifest is newer than the stored value, `hasUpdate` is true.
 * Call `markSeen()` to dismiss the notification and persist the new value.
 * Call `refresh()` to force a re-fetch immediately (e.g. from a "Check for
 * updates" button).
 *
 * Gracefully handles a missing/failed manifest fetch (e.g. dev without a
 * generated manifest yet) — `manifest` remains null and `hasUpdate` remains
 * false, same as before this was refactored to share its fetch with
 * versionedTileUrl()'s cache.
 */
export function useDataManifest(): UseDataManifestResult {
  const [manifest, setManifest] = useState<DataManifest | null>(getCachedTileManifest())
  const [hasUpdate, setHasUpdate] = useState(false)
  const [checking, setChecking] = useState(false)
  const seenRef = useRef<string | null>(null)

  const applyManifest = (data: TileManifest | null, seen: string | null) => {
    if (!data) return
    setManifest(data)
    if (seen === null) {
      // First visit — no previous seen value. Silently mark as seen so the
      // banner only appears when data is updated after the user's first load.
      localStorage.setItem(LS_KEY, data.generated_at)
      seenRef.current = data.generated_at
    } else if (data.generated_at !== seen) {
      setHasUpdate(true)
    }
  }

  useEffect(() => {
    seenRef.current = localStorage.getItem(LS_KEY)
    const seen = seenRef.current
    // main.tsx already kicked off loadTileManifest() at bootstrap -- await
    // that same in-flight/resolved promise rather than starting a second
    // independent fetch (loadTileManifest() is itself idempotent/memoized,
    // see @open-vfr/shared/tileManifest).
    loadTileManifest(TILES_BASE_URL).then(() => {
      applyManifest(getCachedTileManifest(), seen)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const markSeen = () => {
    if (!manifest) return
    localStorage.setItem(LS_KEY, manifest.generated_at)
    seenRef.current = manifest.generated_at
    setHasUpdate(false)
  }

  const refresh = () => {
    setChecking(true)
    const seen = seenRef.current
    refreshTileManifest(TILES_BASE_URL)
      .then(() => applyManifest(getCachedTileManifest(), seen))
      .finally(() => setChecking(false))
  }

  return { manifest, hasUpdate, checking, markSeen, refresh }
}
