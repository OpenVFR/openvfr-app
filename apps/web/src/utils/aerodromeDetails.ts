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
  parseAerodromeDetails, localInfo,
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

export function useCircuitFocus(): CircuitFocus | null {
  return useSyncExternalStore(
    (cb) => { focusSubs.add(cb); return () => { focusSubs.delete(cb) } },
    () => focus,
  )
}
