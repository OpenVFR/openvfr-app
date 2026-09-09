/**
 * src/utils/svgIconLoader.ts
 *
 * Shared helper: fetches a source SVG (from public/poi_icons/), recolours it
 * via injected `fill`/`color` attributes on the root <svg>, rasterises it to
 * a canvas at 2× resolution, and registers it as a named MapLibre image.
 *
 * Handles two source SVG conventions in one pass:
 *   1. Plain black-fill paths (Temaki/Maki downloads) — inherit the
 *      injected `fill` attribute since they set no fill of their own.
 *   2. `fill="currentColor"` paths (our hand-written navaid/aerodrome
 *      geometric symbols) — resolve against the injected `color` attribute.
 *
 * Same technique as registerAircraftImageFromSvg in aircraftIcon.ts.
 */

import type * as maplibregl from 'maplibre-gl'

// Dedupe concurrent fetches: registerAllImages fires on every
// 'styleimagemissing' event, which can rapid-fire for the same id before
// the first fetch resolves.
const inFlight = new Set<string>()

export async function registerColoredSvgIcon(
  map: maplibregl.Map,
  id: string,
  svgUrl: string,
  color: string,
  sizePx: number,
): Promise<void> {
  if (map.hasImage(id) || inFlight.has(id)) return
  inFlight.add(id)

  try {
    const res = await fetch(svgUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${svgUrl}`)
    let svgText = await res.text()

    svgText = svgText.replace(/(<svg\b)/, `$1 fill="${color}" color="${color}"`)

    const blob    = new Blob([svgText], { type: 'image/svg+xml' })
    const blobUrl = URL.createObjectURL(blob)

    await new Promise<void>((resolve, reject) => {
      const img = new Image(sizePx, sizePx)
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width  = sizePx
        canvas.height = sizePx
        const ctx = canvas.getContext('2d')!
        ctx.shadowColor = 'rgba(0,0,0,0.45)'
        ctx.shadowBlur  = 3
        ctx.drawImage(img, 0, 0, sizePx, sizePx)
        URL.revokeObjectURL(blobUrl)
        const imageData = ctx.getImageData(0, 0, sizePx, sizePx)
        if (map.hasImage(id)) map.removeImage(id)
        map.addImage(id, imageData, { pixelRatio: 2 })
        resolve()
      }
      img.onerror = () => {
        URL.revokeObjectURL(blobUrl)
        reject(new Error(`Failed to render SVG: ${svgUrl}`))
      }
      img.src = blobUrl
    })
  } finally {
    inFlight.delete(id)
  }
}
