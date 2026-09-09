import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import css from './FindFeature.module.css'
import { TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'

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
// Parse a lat/lon string in common VFR formats:
//   59.123,18.456  |  59.123 18.456  |  N59.123 E18.456
// Returns null if not recognised.
// ---------------------------------------------------------------------------
function parseLatLon(q: string): FindResult | null {
  const clean = q.trim().replace(/[°,]/g, ' ').replace(/\s+/g, ' ')
  const m = clean.match(
    /^([NS]?\s*-?\d+(?:\.\d+)?)\s+([EW]?\s*-?\d+(?:\.\d+)?)$/i
  )
  if (!m) return null
  let lat = parseFloat(m[1].replace(/[NS]/i, '').trim())
  let lng = parseFloat(m[2].replace(/[EW]/i, '').trim())
  if (/S/i.test(m[1])) lat = -lat
  if (/W/i.test(m[2])) lng = -lng
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  const sub = `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`
  return { kind: 'LL', id: sub, name: sub, sub: 'Coordinates', lng, lat }
}

// ---------------------------------------------------------------------------
// In-memory search index — loaded once on first keystroke.
// ---------------------------------------------------------------------------
let _index: FindResult[] | null = null
let _loading = false
const _listeners: Array<() => void> = []

function loadIndex(): Promise<FindResult[]> {
  if (_index) return Promise.resolve(_index)
  return new Promise((resolve) => {
    _listeners.push(() => resolve(_index!))
    if (_loading) return
    _loading = true

    const aeroP = fetch(versionedTileUrl(TILES_BASE_URL, 'se-aerodromes.geojson'))
      .then(r => r.json())
      .then((fc: { features: { geometry: { coordinates: [number, number] }; properties: Record<string, unknown> }[] }) =>
        fc.features.map((f): FindResult => ({
          kind: 'AD',
          id:   String(f.properties.icao ?? ''),
          name: String(f.properties.name ?? f.properties.icao ?? ''),
          sub:  String(f.properties.icao ?? ''),
          lng:  f.geometry.coordinates[0],
          lat:  f.geometry.coordinates[1],
        }))
      )

    const navP = fetch(versionedTileUrl(TILES_BASE_URL, 'se-navaids.geojson'))
      .then(r => r.json())
      .then((fc: { features: { geometry: { coordinates: [number, number] }; properties: Record<string, unknown> }[] }) =>
        fc.features.map((f): FindResult => ({
          kind: (f.properties.kind === 'VOR' || String(f.properties.navaid_type ?? '').startsWith('VOR')) ? 'VOR' : 'NDB',
          id:   String(f.properties.id ?? ''),
          name: String(f.properties.name ?? f.properties.id ?? ''),
          sub:  String(f.properties.freq_str ?? ''),
          lng:  f.geometry.coordinates[0],
          lat:  f.geometry.coordinates[1],
        }))
      )

    const wpP = fetch(versionedTileUrl(TILES_BASE_URL, 'se-waypoints.geojson'))
      .then(r => r.json())
      .then((fc: { features: { geometry: { coordinates: [number, number] }; properties: Record<string, unknown> }[] }) =>
        fc.features.map((f): FindResult => ({
          kind: String(f.properties.wp_type ?? '') === 'MRP' ? 'MRP' : 'RP',
          id:   String(f.properties.id ?? ''),
          name: String(f.properties.name ?? f.properties.id ?? ''),
          sub:  String(f.properties.aerodrome ?? f.properties.wp_type ?? ''),
          lng:  f.geometry.coordinates[0],
          lat:  f.geometry.coordinates[1],
        }))
      )

    Promise.all([aeroP, navP, wpP]).then(([ads, navs, wps]) => {
      _index = [...ads, ...navs, ...wps]
      _listeners.forEach(cb => cb())
      _listeners.length = 0
    })
  })
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

  // Update results reactively when index loads mid-typing
  useEffect(() => {
    if (index && query) setResults(search(query, index))
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
