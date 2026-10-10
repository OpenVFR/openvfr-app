import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import css from './FindFeature.module.css'
import { loadCountryGeojson, activeCountriesKey } from '@open-vfr/shared/countryData'
import { parseCoordinate, formatCoordinate } from '@open-vfr/shared/coordinateParse'

export type FindResult = {
  kind: 'AD' | 'VOR' | 'NDB' | 'MRP' | 'RP' | 'LL'
  id: string
  name: string
  sub: string
  lng: number
  lat: number
}

interface Props {
  onResult: (r: FindResult) => void
  onAddToRoute?: (wp: { lng: number; lat: number; name: string }) => void
}

// ---------------------------------------------------------------------------
// Parse a coordinate string (DD / DDM / DMS / compact NOTAM form, leading or
// trailing hemisphere letters, lon-first) -- see shared coordinateParse.ts.
// The result is echoed back in the style the user typed.
// ---------------------------------------------------------------------------
function parseLatLon(q: string): FindResult | null {
  const p = parseCoordinate(q)
  if (!p) return null
  const label = formatCoordinate(p.lat, p.lng, p.format)
  return { kind: 'LL', id: label, name: label, sub: 'Coordinates', lng: p.lng, lat: p.lat }
}

// ---------------------------------------------------------------------------
// In-memory search index — loaded once on first keystroke.
// ---------------------------------------------------------------------------
// Keyed by the active countries: a new selection rebuilds the index.
type IndexFc = { features: { geometry: { coordinates: [number, number] }; properties: Record<string, unknown> }[] }
let _index: { key: string; promise: Promise<FindResult[]> } | null = null

function loadIndex(): Promise<FindResult[]> {
  const key = activeCountriesKey()
  if (_index?.key === key) return _index.promise
  const promise = buildIndex()
  promise.catch(() => { if (_index?.promise === promise) _index = null })
  _index = { key, promise }
  return promise
}

function buildIndex(): Promise<FindResult[]> {
  {
    const aeroP = (loadCountryGeojson('aerodromes') as Promise<unknown> as Promise<IndexFc>)
      .then((fc: IndexFc) =>
        fc.features.map((f): FindResult => ({
          kind: 'AD',
          id:   String(f.properties.icao ?? ''),
          name: String(f.properties.name ?? f.properties.icao ?? ''),
          sub:  String(f.properties.icao ?? ''),
          lng:  f.geometry.coordinates[0],
          lat:  f.geometry.coordinates[1],
        }))
      )

    const navP = (loadCountryGeojson('navaids') as Promise<unknown> as Promise<IndexFc>)
      .then((fc: IndexFc) =>
        fc.features.map((f): FindResult => ({
          kind: (f.properties.kind === 'VOR' || String(f.properties.navaid_type ?? '').startsWith('VOR')) ? 'VOR' : 'NDB',
          id:   String(f.properties.id ?? ''),
          name: String(f.properties.name ?? f.properties.id ?? ''),
          sub:  String(f.properties.freq_str ?? ''),
          lng:  f.geometry.coordinates[0],
          lat:  f.geometry.coordinates[1],
        }))
      )

    const wpP = (loadCountryGeojson('waypoints') as Promise<unknown> as Promise<IndexFc>)
      .then((fc: IndexFc) =>
        fc.features.map((f): FindResult => ({
          kind: String(f.properties.wp_type ?? '') === 'MRP' ? 'MRP' : 'RP',
          id:   String(f.properties.id ?? ''),
          name: String(f.properties.name ?? f.properties.id ?? ''),
          sub:  String(f.properties.aerodrome ?? f.properties.wp_type ?? ''),
          lng:  f.geometry.coordinates[0],
          lat:  f.geometry.coordinates[1],
        }))
      )

    return Promise.all([aeroP, navP, wpP]).then(([ads, navs, wps]) => [...ads, ...navs, ...wps])
  }
}

function search(q: string, index: FindResult[]): FindResult[] {
  const up = q.toUpperCase().trim()
  if (!up) return []
  // Exact ICAO/id prefix first, then name substring
  const exact = index.filter(r => r.id.toUpperCase().startsWith(up))
  const names = index.filter(r =>
    !r.id.toUpperCase().startsWith(up) &&
    (r.name.toUpperCase().includes(up) || r.id.toUpperCase().includes(up))
  )
  return [...exact, ...names].slice(0, 12)
}

const BADGE_CLASS: Record<FindResult['kind'], string> = {
  AD:  css.badgeAD,
  VOR: css.badgeVOR,
  NDB: css.badgeNDB,
  MRP: css.badgeMRP,
  RP:  css.badgeRP,
  LL:  css.badgeLL,
}

export default function FindFeature({ onResult, onAddToRoute }: Props) {
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState<FindResult[]>([])
  const [active, setActive]     = useState(0)
  const [index, setIndex]       = useState<FindResult[] | null>(null)
  const [dropRect, setDropRect] = useState<{ left: number; top: number; width: number } | null>(null)
  const inputRef                = useRef<HTMLInputElement>(null)
  const wrapRef                 = useRef<HTMLDivElement>(null)

  // Keyboard shortcut: / or Ctrl+F focuses the search bar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        inputRef.current?.focus()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleChange = useCallback((val: string) => {
    setQuery(val)
    setActive(0)

    // Try lat/lon parse first
    const ll = parseLatLon(val)
    if (ll) { setResults([ll]); return }

    if (!val.trim()) { setResults([]); return }

    if (index) {
      setResults(search(val, index))
    } else {
      // Lazy-load the index on first keystroke
      loadIndex().then(idx => {
        setIndex(idx)
        setResults(search(val, idx))
      })
    }
  }, [index])

  // Update results reactively when index loads mid-typing. Must honour the
  // coordinate parse first, same as handleChange -- otherwise this effect
  // (which also fires on every query change once the index is loaded)
  // overwrites a parsed-coordinate result with an empty index search.
  useEffect(() => {
    if (!index || !query) return
    const ll = parseLatLon(query)
    setResults(ll ? [ll] : search(query, index))
  }, [index, query])

  const pick = useCallback((r: FindResult) => {
    onResult(r)
    setQuery('')
    setResults([])
    setDropRect(null)
    inputRef.current?.blur()
  }, [onResult])

  // Recalculate dropdown position whenever results change.
  useEffect(() => {
    if (results.length === 0 && !(query.trim() && index)) {
      setDropRect(null)
      return
    }
    const rect = wrapRef.current?.getBoundingClientRect()
    if (rect) setDropRect({ left: rect.left, top: rect.bottom + 4, width: rect.width })
  }, [results, query, index])

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    if (e.key === 'Enter' && results.length > 0) { e.preventDefault(); pick(results[active]) }
    if (e.key === 'Escape') { setQuery(''); setResults([]); inputRef.current?.blur() }
  }

  return (
    <div ref={wrapRef} className={css.wrap}>
      <div className={css.bar}>
        <input
          ref={inputRef}
          className={css.input}
          placeholder="Find aerodrome, navaid, waypoint…"
          value={query}
          onChange={e => handleChange(e.target.value)}
          onKeyDown={handleKey}
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <button className={css.clear} onClick={() => { setQuery(''); setResults([]); setDropRect(null) }}>✕</button>
        )}
      </div>

      {dropRect && (results.length > 0 || (query.trim() && results.length === 0 && index)) && createPortal(
        <div
          className={css.dropdown}
          style={{ left: dropRect.left, top: dropRect.top, width: dropRect.width }}
        >
          {results.map((r, i) => (
            <div
              key={`${r.kind}:${r.id}:${i}`}
              className={`${css.item} ${i === active ? css.active : ''}`}
              onMouseEnter={() => setActive(i)}
            >
              <div
                className={css.itemMain}
                onMouseDown={e => { e.preventDefault(); pick(r) }}
              >
                <span className={`${css.badge} ${BADGE_CLASS[r.kind]}`}>{r.kind}</span>
                <span className={css.name}>{r.id && r.id !== r.name ? `${r.id} — ${r.name}` : r.name}</span>
                {r.sub && <span className={css.sub}>{r.sub}</span>}
              </div>
              {onAddToRoute && r.kind === 'AD' && (
                <button
                  className={css.addBtn}
                  title="Add to route"
                  onMouseDown={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    onAddToRoute({ lng: r.lng, lat: r.lat, name: r.id })
                  }}
                >+</button>
              )}
            </div>
          ))}
          {results.length === 0 && (
            <div className={css.noResults}>No results for "{query}"</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
