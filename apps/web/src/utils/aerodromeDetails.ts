/**
 * Loading for the experimental aerodrome details:
 * the per-country `<cc>-aerodrome-details.geojson` layer plus schematic
 * circuits, and one aerodrome's local-information fields. Both files are
 * optional; absence is normal and shows nothing. See
 * packages/shared/src/aerodromeDetails.ts.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import {
  parseAerodromeDetails, localInfo, circuitNotes,
  type DetailProps, type LocalInfo,
} from '@open-vfr/shared/aerodromeDetails'
import { countryFileUrlReady, countryDatasetFile, loadCountryGeojson } from '@open-vfr/shared/countryData'
import { useUnreviewedShown } from './unreviewedCurated'
import { loadOptionalJson } from './optionalJson'
import { buildDetailsMapData, type CircuitFocus } from '@open-vfr/shared/aerodromeDetailsStyle'
import { useActiveCountries } from './countryData'

const cache = new Map<string, Promise<FeatureCollection<Geometry, DetailProps> | null>>()

/** The details file; `preview` = the one with every airfield's unreviewed values (admins only), falling back to the public file. */
export async function loadAerodromeDetails(country: string, preview = false): Promise<FeatureCollection<Geometry, DetailProps> | null> {
  // Versioned URL once the manifest is known; a file the manifest does not list (not published) keeps its unversioned 404 path.
  const url = await countryFileUrlReady(countryDatasetFile(country, preview ? 'aerodromeDetailsPreview' : 'aerodromeDetails'))
  const p = loadOptionalJson(cache, url, parseAerodromeDetails)
  return preview ? p.then(d => d ?? loadAerodromeDetails(country, false)) : p
}

/** The aerodromes data the informational layer reads (curated fields, schematic circuits). The preview copy has every airfield's
 *  unreviewed values too; the map's own aerodrome symbols and routing never use it. Falls back to the public file. */
export function loadCuratedAerodromes(countries: readonly string[], preview: boolean): Promise<FeatureCollection> {
  if (!preview) return loadCountryGeojson('aerodromes', countries)
  return loadCountryGeojson('aerodromesPreview', countries).catch(() => loadCountryGeojson('aerodromes', countries))
}

const idOf = (f: Feature): string | null => {
  const p = (f.properties ?? {}) as Record<string, unknown>
  return (typeof p['icao'] === 'string' && p['icao']) || (typeof p['local_id'] === 'string' && p['local_id']) || null
}

/** Everything the map layer draws for the active countries: the details file plus schematic circuits. */
export function useAerodromeDetailsLayer(enabled: boolean): FeatureCollection<Geometry, DetailProps> | null {
  const { countries, key } = useActiveCountries()
  const preview = useUnreviewedShown()
  const [fc, setFc] = useState<FeatureCollection<Geometry, DetailProps> | null>(null)
  useEffect(() => {
    if (!enabled) { setFc(null); return }
    let cancelled = false
    Promise.all([
      Promise.all(countries.map(c => loadAerodromeDetails(c, preview))),
      loadCuratedAerodromes(countries, preview).catch(() => ({ type: 'FeatureCollection', features: [] }) as FeatureCollection),
    ]).then(([details, aerodromes]) => {
      if (cancelled) return
      setFc(buildDetailsMapData(details.flatMap(d => d?.features ?? []), aerodromes.features))
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, preview])
  return fc
}

/** One aerodrome's local-information fields (circuits, local rules, ...) from the loaded aerodromes data. */
export function useLocalInfo(icao: string | undefined, enabled: boolean): LocalInfo | null {
  const { countries, key } = useActiveCountries()
  const preview = useUnreviewedShown()
  const [info, setInfo] = useState<LocalInfo | null>(null)
  useEffect(() => {
    setInfo(null)
    if (!enabled || !icao) return
    let cancelled = false
    loadCuratedAerodromes(countries, preview).then((fc) => {
      if (cancelled) return
      const f = fc.features.find(x => idOf(x) === icao)
      setInfo(f ? localInfo((f.properties ?? {}) as Record<string, unknown>) : null)
    }).catch(() => {})
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icao, enabled, key, preview])
  return info
}

/** The notes the sources give an aerodrome's drawn circuits, for the card (empty without a details file). */
export function useCircuitNotes(icao: string | undefined, enabled: boolean): string[] {
  const { countries, key } = useActiveCountries()
  const preview = useUnreviewedShown()
  const [notes, setNotes] = useState<string[]>([])
  useEffect(() => {
    setNotes([])
    if (!enabled || !icao) return
    let cancelled = false
    Promise.all(countries.map(c => loadAerodromeDetails(c, preview).catch(() => null)))
      .then(all => { if (!cancelled) setNotes(circuitNotes(all.flatMap(d => d?.features ?? []), icao)) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icao, enabled, key, preview])
  return notes
}

// ── Circuit focus: the runway end tapped in the aerodrome popup ────────────────
// While set, the map draws only that runway end's circuits at that aerodrome (other aerodromes are unaffected).

export type { CircuitFocus }

let focus: CircuitFocus | null = null
const focusSubs = new Set<() => void>()

export function setCircuitFocus(f: CircuitFocus | null): void {
  if (f?.aerodrome === focus?.aerodrome && f?.runway === focus?.runway) return
  focus = f
  focusSubs.forEach(s => s())
}

// A tap on a runway end ON THE MAP chooses that end too. The card of that aerodrome owns the focus (it clears it when it closes or shows another aerodrome), so:
// the card that is open for the aerodrome takes the focus at once (a second tap on the same end clears it), and for a card still to open the choice waits and
// the card applies it when it appears.
let mountedCard: string | null = null
let pending: CircuitFocus | null = null
let pendingAt = 0
let takenAt = 0
const RETAKE_MS = 300          // React runs a card's effect twice in development (mount, clean up, mount): the second run must find the choice too
const PENDING_MS = 2500        // a choice whose card never opens must not apply to one opened much later

/** The aerodrome card that is open now (or null): set by the card itself. */
export function setMountedCard(id: string | null): void { mountedCard = id }

/** Choose a runway end from the map. Returns true when it was applied at once (the card is open), false when it waits for the card to open. */
export function chooseRunwayEndOnMap(f: CircuitFocus): boolean {
  if (mountedCard === f.aerodrome) {
    setCircuitFocus(focus?.aerodrome === f.aerodrome && focus.runway === f.runway ? null : f)
    return true
  }
  pending = f
  pendingAt = Date.now()
  takenAt = 0
  return false
}

/** Called by a card when it opens: the choice made on the map for its aerodrome, once. */
export function takePendingCircuitFocus(aerodrome: string | null): CircuitFocus | null {
  const f = pending
  const now = Date.now()
  if (!f || f.aerodrome !== aerodrome || now - pendingAt > PENDING_MS) { pending = null; return null }
  if (!takenAt) takenAt = now
  if (now - takenAt > RETAKE_MS) { pending = null; return null }          // taken once already: not again for a card opened later
  return f
}

export function useCircuitFocus(): CircuitFocus | null {
  return useSyncExternalStore(
    (cb) => { focusSubs.add(cb); return () => { focusSubs.delete(cb) } },
    () => focus,
  )
}

// Relevant aerodrome: the one whose card was opened last. The reporting points of club maps and charts are drawn only for it (they are
// one airfield's arrival points, noise for a pilot just passing). Stays after the card closes, until another aerodrome is opened or
// the app is closed.
const relevantSubs = new Set<() => void>()
const NONE: readonly string[] = []
let cachedList: readonly string[] = NONE

export function setRelevantAerodrome(id: string | null): void {
  const next = id ? [id] : NONE
  if (next.length === cachedList.length && next[0] === cachedList[0]) return
  cachedList = next
  relevantSubs.forEach(s => s())
}
/** The aerodromes whose club reporting points are drawn (a stable array, so React does not re-render for nothing). */
export function useRelevantAerodromes(): readonly string[] {
  return useSyncExternalStore(
    (cb) => { relevantSubs.add(cb); return () => { relevantSubs.delete(cb) } },
    () => cachedList,
  )
}
