/**
 * src/utils/trafficIcons.ts
 *
 * Registers aircraft silhouette icons for the MapLibre traffic layer.
 *
 * Each icon is loaded from public/aircraft_icons/, tinted white with a dark
 * outline, rendered to a 24×24 logical px canvas (48×48 canvas px) and
 * registered with { pixelRatio: 2 } for crisp HiDPI display.
 *
 * Icon selection uses ADS-B emitter category + ground speed together so that
 * targets get a distinctive silhouette rather than only a weight-class shape:
 *
 *   Cat 0 / unknown  → generic (a0)
 *   Cat 1 light      → cessna  (<250 kts)  |  learjet  (≥250 kts)
 *   Cat 2 small      → cessna  (<200 kts)  |  dh8a     (200–320 kts)  |  crjx (≥320)
 *   Cat 3 large      → dh8a    (<280 kts)  |  a320     (280–400 kts)  |  b737 (≥400)
 *   Cat 4 B757-class → b737
 *   Cat 5 heavy      → b747    (<480 kts)  |  a380     (≥480 kts)
 *   Cat 6 hi-perf    → f15
 *   Cat 7 rotorcraft → a7 (helicopter)
 *   Cat 8 glider     → b1
 *   Cat 9 LTA        → b2
 *   Cat 10 para      → b3
 *   Cat 11/12 ultra  → b4
 *   Cat 13 UAV       → c0
 *   fallback (speed) → cessna (<150) | dh8a (150–300) | a320 (300–450) | b747 (≥450)
 */

import type * as maplibregl from 'maplibre-gl'

/** Logical icon dimension (CSS px). Canvas is drawn at 2× = 48 px. */
const SZ  = 24
const SZ2 = SZ * 2

/**
 * All (imageId, svgPath) pairs registered by registerTrafficIcons().
 * The icon-image layer property uses ['get', 'iconId'] — a pre-computed
 * property set in MapView when building the GeoJSON feature set.
 */
export const TRAFFIC_ICON_ENTRIES: readonly [id: string, svgPath: string][] = [
  // ── Generic / fallback ────────────────────────────────────────────────
  ['traffic-icon-a0',      '/aircraft_icons/a0.svg'],      // generic / no info
  // ── Special categories ────────────────────────────────────────────────
  ['traffic-icon-a7',      '/aircraft_icons/a7.svg'],      // rotorcraft / helicopter
  ['traffic-icon-b1',      '/aircraft_icons/b1.svg'],      // glider / sailplane
  ['traffic-icon-b2',      '/aircraft_icons/b2.svg'],      // lighter-than-air
  ['traffic-icon-b3',      '/aircraft_icons/b3.svg'],      // parachutist / skydiver
  ['traffic-icon-b4',      '/aircraft_icons/b4.svg'],      // ultralight / hang-glider
  ['traffic-icon-c0',      '/aircraft_icons/c0.svg'],      // UAV / drone
  // ── Fixed-wing silhouettes (category + speed) ─────────────────────────
  ['traffic-icon-cessna',  '/aircraft_icons/cessna.svg'],  // GA piston single
  ['traffic-icon-learjet', '/aircraft_icons/learjet.svg'], // business jet
  ['traffic-icon-dh8a',    '/aircraft_icons/dh8a.svg'],    // turboprop regional
  ['traffic-icon-crjx',    '/aircraft_icons/crjx.svg'],    // small regional jet
  ['traffic-icon-a320',    '/aircraft_icons/a320.svg'],    // narrow-body jet
  ['traffic-icon-b737',    '/aircraft_icons/b737.svg'],    // narrow-body / B757
  ['traffic-icon-b747',    '/aircraft_icons/b747.svg'],    // wide-body heavy
  ['traffic-icon-a380',    '/aircraft_icons/a380.svg'],    // super-heavy
  ['traffic-icon-f15',     '/aircraft_icons/f15.svg'],     // high-performance
]

/** Fallback image ID used when the category is unknown or unmapped. */
export const TRAFFIC_ICON_FALLBACK = 'traffic-icon-a0'

// ── Icon selection ────────────────────────────────────────────────────────────

/**
 * Pick the best silhouette icon for a traffic target.
 * Called in MapView when building GeoJSON features; result stored as `iconId`
 * property so the MapLibre layer can use `['get', 'iconId']`.
 */
export function selectTrafficIcon(
  category: number | null,
  speedKts: number,
): string {
  const cat = category ?? 0
  switch (cat) {
    // ── Special categories — silhouette determined solely by category ─────
    case 7:  return 'traffic-icon-a7'      // rotorcraft
    case 8:  return 'traffic-icon-b1'      // glider
    case 9:  return 'traffic-icon-b2'      // lighter-than-air
    case 10: return 'traffic-icon-b3'      // parachutist
    case 11:
    case 12: return 'traffic-icon-b4'      // ultralight
    case 13: return 'traffic-icon-c0'      // UAV

    // ── Fixed-wing — discriminated by speed ───────────────────────────────
    case 1:  // light < 15 500 lbs
      return speedKts >= 250 ? 'traffic-icon-learjet' : 'traffic-icon-cessna'

    case 2:  // small 15 500–75 000 lbs
      if (speedKts >= 320) return 'traffic-icon-crjx'
      if (speedKts >= 200) return 'traffic-icon-dh8a'
      return 'traffic-icon-cessna'

    case 3:  // large 75 000–300 000 lbs
      if (speedKts >= 400) return 'traffic-icon-b737'
      if (speedKts >= 280) return 'traffic-icon-a320'
      return 'traffic-icon-dh8a'

    case 4:  // high-vortex large (B757-class)
      return 'traffic-icon-b737'

    case 5:  // heavy > 300 000 lbs
      return speedKts >= 480 ? 'traffic-icon-a380' : 'traffic-icon-b747'

    case 6:  // high performance (military)
      return 'traffic-icon-f15'

    default: {
      // Cat 0 (no info) + cat 14–19 (reserved/surface/space) — fall back to speed
      if (speedKts >= 450) return 'traffic-icon-b747'
      if (speedKts >= 300) return 'traffic-icon-a320'
      if (speedKts >= 150) return 'traffic-icon-dh8a'
      if (speedKts >= 30)  return 'traffic-icon-cessna'
      return 'traffic-icon-a0'
    }
  }
}

// ── Per-icon loader ───────────────────────────────────────────────────────────

async function loadAndRegister(
  map: maplibregl.Map,
  id: string,
  svgPath: string,
): Promise<void> {
  const res = await fetch(svgPath)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${svgPath}`)
  let svgText = await res.text()

  // Derive stroke-width proportional to the SVG viewBox width.
  const vbMatch = svgText.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+)/)
  const vbWidth = vbMatch ? parseFloat(vbMatch[1]) : 200
  const sw = Math.round(vbWidth * 0.025)

  // Inject presentation attributes: white fill, dark outline.
  svgText = svgText.replace(/(<svg\b)/, `$1 fill="white" stroke="#1e293b" stroke-width="${sw}"`)

  const blob    = new Blob([svgText], { type: 'image/svg+xml' })
  const blobUrl = URL.createObjectURL(blob)

  await new Promise<void>((resolve, reject) => {
    const img = new Image(SZ2, SZ2)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width  = SZ2
      canvas.height = SZ2
      const ctx = canvas.getContext('2d')!
      ctx.shadowColor = 'rgba(0,0,0,0.55)'
      ctx.shadowBlur  = 4
      ctx.drawImage(img, 0, 0, SZ2, SZ2)
      URL.revokeObjectURL(blobUrl)
      const imageData = ctx.getImageData(0, 0, SZ2, SZ2)
      if (map.hasImage(id)) map.removeImage(id)
      map.addImage(id, imageData, { pixelRatio: 2 })
      resolve()
    }
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl)
      reject(new Error(`Failed to render SVG: ${svgPath}`))
    }
    img.src = blobUrl
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Registers all traffic category icons in the given MapLibre map.
 *
 * Async (SVG fetch + canvas render per icon). Call fire-and-forget from
 * styledata / styleimagemissing handlers. Each icon is loaded in parallel;
 * individual failures are swallowed so one missing SVG doesn't block others.
 * Safe to call multiple times — existing images are replaced, not duplicated.
 */
export async function registerTrafficIcons(map: maplibregl.Map): Promise<void> {
  await Promise.all(
    TRAFFIC_ICON_ENTRIES.map(([id, path]) =>
      loadAndRegister(map, id, path).catch(console.warn),
    ),
  )
}
