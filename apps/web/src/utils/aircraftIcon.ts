/**
 * Canvas-drawn aircraft (top-down plan-view) registered as a MapLibre named image.
 *
 * Drawn at 2× resolution for crisp HiDPI rendering.
 * Aircraft nose points UP — MapLibre `icon-rotate` then rotates it to the true track.
 *
 * Registered image ID: `aircraft-icon`
 * Call registerAircraftImage(map) inside a styledata / styleimagemissing handler.
 * Call registerAircraftImageFromSvg(map, url) to replace it with an SVG-based icon.
 */

import type * as maplibregl from 'maplibre-gl'
import type { AircraftProfileDocType } from '../db/index'

const SZ  = 40     // logical icon size (CSS px)
const SZ2 = SZ * 2 // canvas pixel size

// ── Category → SVG icon mapping ─────────────────────────────────────────────
// Keys match AircraftProfileDocType['category']. Icons live in public/aircraft_icons/.
// a1 = ADS-B category A1 (light fixed-wing)   b1 = glider/sailplane
// a2 = small fixed-wing                         b4 = ultralight
// a7 = rotorcraft
const CATEGORY_ICON: Partial<Record<AircraftProfileDocType['category'], string>> = {
  SEP:    '/aircraft_icons/cessna.svg',
  MEP:    '/aircraft_icons/a2.svg',
  MICRO:  '/aircraft_icons/b4.svg',
  GYRO:   '/aircraft_icons/a7.svg',
  HELI:   '/aircraft_icons/a7.svg',
  TMG:    '/aircraft_icons/b1.svg',
  GLIDER: '/aircraft_icons/b1.svg',
}

/** Returns the public SVG URL for the given aircraft category, or null if unmapped. */
export function aircraftIconUrl(category: AircraftProfileDocType['category']): string | null {
  return CATEGORY_ICON[category] ?? null
}

/**
 * Fetches an SVG from `svgUrl`, recolours it white-on-dark, renders to canvas,
 * and registers (or replaces) the `aircraft-icon` image in MapLibre.
 * Falls back silently — the canvas icon remains if the load fails.
 */
export async function registerAircraftImageFromSvg(
  map: maplibregl.Map,
  svgUrl: string,
): Promise<void> {
  const res = await fetch(svgUrl)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${svgUrl}`)
  let svgText = await res.text()

  // Parse the viewBox width to derive a proportional stroke-width.
  // viewBox format: "minX minY width height"
  const vbMatch = svgText.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+)/)
  const vbWidth = vbMatch ? parseFloat(vbMatch[1]) : 200
  const sw = Math.round(vbWidth * 0.025)

  // Inject presentation attributes so all paths render white with a dark outline.
  // Paths that override fill/stroke via an inline `style` attribute are unaffected
  // by these SVG-level attributes, but will still inherit the white fill.
  svgText = svgText.replace(/(<svg\b)/, `$1 fill="white" stroke="#1a1a2e" stroke-width="${sw}"`)

  const blob    = new Blob([svgText], { type: 'image/svg+xml' })
  const blobUrl = URL.createObjectURL(blob)

  return new Promise<void>((resolve, reject) => {
    const img = new Image(SZ2, SZ2)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width  = SZ2
      canvas.height = SZ2
      const ctx = canvas.getContext('2d')!
      ctx.shadowColor = 'rgba(0,0,0,0.60)'
      ctx.shadowBlur  = 5
      ctx.drawImage(img, 0, 0, SZ2, SZ2)
      URL.revokeObjectURL(blobUrl)
      const imageData = ctx.getImageData(0, 0, SZ2, SZ2)
      if (map.hasImage('aircraft-icon')) map.removeImage('aircraft-icon')
      map.addImage('aircraft-icon', imageData, { pixelRatio: 2 })
      resolve()
    }
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl)
      reject(new Error(`Failed to render SVG: ${svgUrl}`))
    }
    img.src = blobUrl
  })
}

export function registerAircraftImage(map: maplibregl.Map): void {
  if (map.hasImage('aircraft-icon')) return

  const canvas = document.createElement('canvas')
  canvas.width  = SZ2
  canvas.height = SZ2
  const ctx = canvas.getContext('2d')!
  ctx.scale(2, 2)  // draw in logical [0, SZ] space

  const cx = SZ / 2  // 20

  // Drop shadow for visibility on both vector and satellite basemaps
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur  = 5

  ctx.fillStyle   = '#ffffff'
  ctx.strokeStyle = '#1a1a2e'
  ctx.lineWidth   = 1.4
  ctx.lineJoin    = 'round'
  ctx.lineCap     = 'round'

  // ── Fuselage ────────────────────────────────────────────────────────────
  ctx.beginPath()
  ctx.moveTo(cx, 2)                                // nose tip
  ctx.quadraticCurveTo(cx + 4, 8, cx + 3.5, 16)  // right shoulder
  ctx.lineTo(cx + 3.5, 26)                         // right waist
  ctx.quadraticCurveTo(cx + 3.5, 30, cx, 32)      // right tail taper
  ctx.quadraticCurveTo(cx - 3.5, 30, cx - 3.5, 26)
  ctx.lineTo(cx - 3.5, 16)
  ctx.quadraticCurveTo(cx - 4, 8, cx, 2)          // left shoulder → nose
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // ── Wings (swept back) ──────────────────────────────────────────────────
  // Right wing
  ctx.beginPath()
  ctx.moveTo(cx + 3, 12)   // wing root leading edge
  ctx.lineTo(cx + 18, 18)  // wing tip
  ctx.lineTo(cx + 17, 21)  // wing tip trailing
  ctx.lineTo(cx + 3.5, 17) // wing root trailing
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // Left wing
  ctx.beginPath()
  ctx.moveTo(cx - 3, 12)
  ctx.lineTo(cx - 18, 18)
  ctx.lineTo(cx - 17, 21)
  ctx.lineTo(cx - 3.5, 17)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // ── Tail fins ────────────────────────────────────────────────────────────
  // Right
  ctx.beginPath()
  ctx.moveTo(cx + 2.5, 26)
  ctx.lineTo(cx + 10,  34)
  ctx.lineTo(cx + 8.5, 36)
  ctx.lineTo(cx + 3.5, 29)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // Left
  ctx.beginPath()
  ctx.moveTo(cx - 2.5, 26)
  ctx.lineTo(cx - 10,  34)
  ctx.lineTo(cx - 8.5, 36)
  ctx.lineTo(cx - 3.5, 29)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // ── Magenta cockpit dot for quick bearing reference ─────────────────────
  ctx.shadowBlur  = 0
  ctx.fillStyle   = '#e040fb'
  ctx.beginPath()
  ctx.arc(cx, 6, 2.2, 0, Math.PI * 2)
  ctx.fill()

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  map.addImage('aircraft-icon', imageData, { pixelRatio: 2 })
}
