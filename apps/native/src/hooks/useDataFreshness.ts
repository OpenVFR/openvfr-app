/**
 * Data-freshness state for the map screen: which countries' airspace data is
 * from a superseded AIRAC cycle.
 *
 * Re-fetches manifest.json when the app returns to the foreground (throttled)
 * instead of relying only on the bootstrap fetch -- a phone woken at the
 * aircraft after days in a bag otherwise keeps judging freshness against the
 * manifest it saw days ago. Native counterpart of the visibilitychange
 * re-check in @open-vfr/shared/tileManifest's startTileManifestPolling().
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { getCachedTileManifest, loadTileManifest, refreshTileManifest } from '@open-vfr/shared/tileManifest'
import { currentAiracCycle, findOutdatedAirac } from '@open-vfr/shared/airac'
import { TILE_BASE } from '../config'

const MIN_RECHECK_MS = 5 * 60 * 1000

export interface DataFreshness {
  outdatedAirac: { country: string; cycle: string }[]
  currentAirac: string
  checking: boolean
  recheck: () => void
}

export function useDataFreshness(): DataFreshness {
  const [outdatedAirac, setOutdated] = useState(() => findOutdatedAirac(getCachedTileManifest()))
  const [checking, setChecking] = useState(false)
  const lastCheckRef = useRef(0)

  const apply = useCallback(() => setOutdated(findOutdatedAirac(getCachedTileManifest())), [])

  const recheck = useCallback(() => {
    lastCheckRef.current = Date.now()
    setChecking(true)
    refreshTileManifest(TILE_BASE).then(apply).finally(() => setChecking(false))
  }, [apply])

  useEffect(() => {
    // Bootstrap fetch is already in flight from index.js -- reuse it.
    lastCheckRef.current = Date.now()
    loadTileManifest(TILE_BASE).then(apply)
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && Date.now() - lastCheckRef.current >= MIN_RECHECK_MS) recheck()
    })
    return () => sub.remove()
  }, [apply, recheck])

  return { outdatedAirac, currentAirac: currentAiracCycle(), checking, recheck }
}
