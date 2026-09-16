import { useEffect, useState } from 'react'
import { startTileManifestPolling, onTileManifestChanged } from '@open-vfr/shared/tileManifest'
import { TILES_BASE_URL } from '../utils/env'
import css from './UpdatePrompt.module.css'

/**
 * Shows a non-intrusive toast when the tile data on R2 has actually changed
 * (a real content update, not just a periodic refetch that returned the same
 * bytes -- see tileManifest.ts's `onTileManifestChanged` for the detection
 * logic and why this exists at all).
 *
 * Deliberately does NOT try to hot-swap already-mounted PMTiles/raster-dem
 * sources in place -- MapLibre sources are built once from
 * `versionedTileUrl()` at style-construction time, and re-adding a source
 * mid-session (region-swap pattern used elsewhere in MapView.tsx) is only
 * exercised for actual region changes today, not arbitrary background data
 * refreshes; risk of partial/inconsistent map state from doing that
 * speculatively on every polling tick isn't worth it for something this
 * infrequent. A full reload is simple, safe, and user-initiated (never
 * yanks the map out from under someone mid-flight-plan) -- same tradeoff
 * `UpdatePrompt.tsx` already makes for app-code updates.
 */
export default function TileUpdatePrompt() {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    const stopPolling = startTileManifestPolling(TILES_BASE_URL)
    const unsubscribe = onTileManifestChanged(() => setAvailable(true))
    return () => {
      stopPolling()
      unsubscribe()
    }
  }, [])

  if (!available) return null

  return (
    <div className={css.toast} role="status" aria-live="polite">
      <span className={css.message}>Updated map data available</span>
      <button
        className={css.updateBtn}
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
      <button
        className={css.dismissBtn}
        onClick={() => setAvailable(false)}
        aria-label="Dismiss tile update notification"
      >
        ✕
      </button>
    </div>
  )
}
