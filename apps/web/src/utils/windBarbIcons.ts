/**
 * src/utils/windBarbIcons.ts
 *
 * WMO-style wind-barb icon for the ambient "wind arrows" map overlay (see
 * useWindGrid.ts / LAYER_GROUPS 'wind') — replaces the earlier single
 * scaled-arrow icon (which turned out visually imperceptible at any
 * reasonable icon-size) with the standard synoptic-chart convention: a
 * shaft with "feathers" whose count/shape encode speed directly, so
 * strength reads at a glance without needing the numeric label.
 *
 * Bucketed to the nearest 5kt (@open-vfr/shared/windBarb) since barb count
 * is discrete, not continuously scalable like the old icon-size approach —
 * one canvas-rasterised MapLibre image per bucket, registered lazily via
 * 'styleimagemissing' the same way registerColoredSvgIcon's callers do,
 * except drawn directly (no SVG source; barb geometry is simple line/
 * triangle shapes cheaper to draw than to author+parse as SVG per bucket).
 *
 * Convention: shaft points in the meteorological "wind FROM" direction
 * (icon drawn pointing north/up, layer rotates by dirDeg directly) — the
 * standard wind-barb reading, distinct from the "points where air is
 * going" arrow convention used elsewhere (in-flight wind gauge, aircraft
 * heading) since barbs are a distinct, internationally standardised symbol
 * pilots already read this way on synoptic/aviation charts.
 */

import type * as maplibregl from 'maplibre-gl'
import { windBarbBucket, allWindBarbBuckets, windBarbColorForSpeed } from '@open-vfr/shared/windBarb'

export const WIND_BARB_ID_PREFIX = 'wind-barb-'
// Legend/label swatch only — the barb icons themselves are now speed-
// tiered (windBarbColorForSpeed: blue/green/amber by strength) rather than
// this single flat colour. Kept as the representative sky-blue swatch
// since MapDisplaySheet's legend shows one colour per layer group, not a
// gradient.
export const WIND_BARB_COLOR = '#38bdf8'

// Raster canvas size (2× logical for HiDPI, matching every other icon's
// pixelRatio:2 registration). Non-square: barbs need more vertical room
// than a square icon-image, matching WMO barb proportions.
const CANVAS_W = 64
const CANVAS_H = 96

export function windBarbIconIdForBucket(bucket: number): string {
  return `${WIND_BARB_ID_PREFIX}${bucket}`
}

function drawWindBarb(ctx: CanvasRenderingContext2D, bucket: number, color: string): void {
  const originX = CANVAS_W / 2
  const stationY = CANVAS_H - 6 // anchor point (icon-anchor: 'bottom' in the style)
  const tipY = 10

  // Contrast fix (found during a pre-release pass comparing web vs native
  // side by side): a Canvas 2D `shadowBlur` halo is a soft, diffuse glow --
  // at blur 1.5 it barely extends past the stroke itself and reads as
  // near-invisible against Protomaps' light basemap fills (tan/beige
  // landuse). Native's PNG generator (gen-wind-barb-icons.mjs) never had
  // this problem because it draws an explicit second pass instead: every
  // shape stroked/filled once, wider, in a solid dark colour underneath,
  // then again at the real width in the speed-tiered colour on top -- a
  // crisp outline that reads on any basemap, not a blur. Mirrored here so
  // web and native are visually identical again.
  const outlineColor = 'rgba(0,0,0,0.7)'
  const strokeW = 3
  const outlineW = strokeW + 1.5

  function drawPass(strokeColor: string, fillColor: string, width: number) {
    ctx.strokeStyle = strokeColor
    ctx.fillStyle = fillColor
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    if (bucket < 3) {
      // Calm: WMO convention draws an open circle around the station point, no shaft.
      ctx.beginPath()
      ctx.arc(originX, stationY - 10, 7, 0, Math.PI * 2)
      ctx.stroke()
      return
    }

    // Shaft: station point to tip.
    ctx.beginPath()
    ctx.moveTo(originX, stationY)
    ctx.lineTo(originX, tipY)
    ctx.stroke()

    let remaining = bucket
    const pennants = Math.floor(remaining / 50); remaining -= pennants * 50
    const fulls = Math.floor(remaining / 10); remaining -= fulls * 10
    const half = remaining >= 5 ? 1 : 0

    const barbGap = 8, barbLen = 15, halfLen = 8
    const rad = Math.PI / 3 // barb angle off the shaft

    let y = tipY
    // Pennants (50kt triangle flags) drawn nearest the tip, then full barbs
    // (10kt), then a single half barb (5kt) closest to the station -- matches
    // the standard reading order (biggest feathers farthest from the station).
    for (let i = 0; i < pennants; i++) {
      const y2 = y + barbGap
      ctx.beginPath()
      ctx.moveTo(originX, y)
      ctx.lineTo(originX + barbLen * Math.sin(rad), y + barbLen * Math.cos(rad) * 0.5)
      ctx.lineTo(originX, y2)
      ctx.closePath()
      ctx.fill()
      y = y2
    }
    for (let i = 0; i < fulls; i++) {
      ctx.beginPath()
      ctx.moveTo(originX, y)
      ctx.lineTo(originX + barbLen * Math.sin(rad), y + barbLen * Math.cos(rad))
      ctx.stroke()
      y += barbGap
    }
    if (half) {
      ctx.beginPath()
      ctx.moveTo(originX, y)
      ctx.lineTo(originX + halfLen * Math.sin(rad), y + halfLen * Math.cos(rad))
      ctx.stroke()
    }
  }

  drawPass(outlineColor, outlineColor, outlineW)
  drawPass(color, color, strokeW)
}

/**
 * Registers the wind-barb icon for whichever bucket `id` (e.g.
 * 'wind-barb-15') encodes. Safe to call for any id — ids not matching the
 * WIND_BARB_ID_PREFIX are ignored, so MapView's single 'styleimagemissing'
 * handler can call this unconditionally alongside every other icon
 * registration function.
 */
export function registerWindBarbIcon(map: maplibregl.Map, id: string): void {
  if (!id.startsWith(WIND_BARB_ID_PREFIX)) return
  if (map.hasImage(id)) return

  const bucket = windBarbBucket(Number(id.slice(WIND_BARB_ID_PREFIX.length)))
  const canvasId = windBarbIconIdForBucket(bucket)
  if (map.hasImage(canvasId)) return

  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  drawWindBarb(ctx, bucket, windBarbColorForSpeed(bucket))
  const imageData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H)
  map.addImage(canvasId, imageData, { pixelRatio: 2 })
  // Also register under the exact requested id if rounding changed it, so
  // MapLibre's pending request for the original id resolves immediately
  // too (it dedupes by exact id, not by bucket).
  if (id !== canvasId && !map.hasImage(id)) map.addImage(id, imageData, { pixelRatio: 2 })
}

/**
 * Eagerly registers every bucket icon (0, 5, ..., 100kt) up front, called
 * from MapView's registerAllImages() alongside every other icon category.
 * Deliberate departure from the lazy 'styleimagemissing'-only pattern used
 * for finite icon sets elsewhere: MapLibre only fires 'styleimagemissing'
 * once per unique image id encountered while parsing a symbol layer's
 * already-loaded tile/GeoJSON data, and does not reliably re-request every
 * distinct id afterwards (observed: only the first missing wind-barb-N id
 * a viewport's data referenced ever fired the event; others silently never
 * rendered). Registering the full fixed bucket set eagerly sidesteps that
 * entirely -- cheap since it's 21 small canvases, once per style load.
 */
export function registerAllWindBarbIcons(map: maplibregl.Map): void {
  for (const bucket of allWindBarbBuckets()) {
    registerWindBarbIcon(map, windBarbIconIdForBucket(bucket))
  }
}
