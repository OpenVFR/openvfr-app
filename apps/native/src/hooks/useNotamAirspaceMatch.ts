/**
 * useNotamAirspaceMatch (native) -- matches regional NOTAMs to charted
 * restricted/danger/TRA areas by designator ("ESD873", "ESR22A"), so the map
 * can hide the NOTAM's coarse Q-line circle and show the real charted
 * polygon highlighted instead. Mirrors apps/web/src/hooks/
 * useNotamAirspaceMatch.ts; the matching itself is shared
 * (@open-vfr/shared/notamMapLayers).
 *
 * The airspace GeoJSON is the active country's file (versioned URL, so a
 * country or data update loads fresh) -- the same file AviationMap draws and
 * the popup queries, cached per URL here. Offline-safe: a failed load just
 * means no matches, i.e. the circles stay.
 */
import { useEffect, useMemo, useState } from 'react'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import {
  buildAirspaceIndex, matchNotamsToAirspace,
  type AirspaceIndexEntry, type MatchedAirspaceNotam,
} from '@open-vfr/shared/notamMapLayers'
import { getTileUrls } from '../config'

export type { MatchedAirspaceNotam }

const _indexCache = new Map<string, Promise<AirspaceIndexEntry[]>>()
function loadIndex(url: string): Promise<AirspaceIndexEntry[]> {
  let p = _indexCache.get(url)
  if (!p) {
    p = fetch(url).then(r => r.json()).then(buildAirspaceIndex)
    p.catch(() => { _indexCache.delete(url) }) // retry on next mount
    _indexCache.set(url, p)
  }
  return p
}

export function useNotamAirspaceMatch(regionalNotams: NotamItem[], enabled = true): {
  matches: MatchedAirspaceNotam[]
  /** NOTAM nmsIds whose designators are all charted -- hide their ad-hoc circle. */
  matchedNotamIds: Set<string>
} {
  const [index, setIndex] = useState<AirspaceIndexEntry[]>([])
  const url = getTileUrls().airspace

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    loadIndex(url).then(i => { if (!cancelled) setIndex(i) }).catch(() => { /* offline: circles stay */ })
    return () => { cancelled = true }
  }, [url, enabled])

  return useMemo(() => matchNotamsToAirspace(index, regionalNotams), [index, regionalNotams])
}
