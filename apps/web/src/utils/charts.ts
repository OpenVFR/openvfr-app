/**
 * Official charts (experimental, behind EXPERIMENTAL_CHARTS): loads the
 * optional per-country charts index (`<cc>-charts.json`, see
 * @open-vfr/shared/chartsIndex) and renders official chart PDFs with
 * pdf.js for the in-app viewer and the georeferenced map overlay.
 *
 * Document bytes come through the API's pass-through endpoint
 * (/api/charts/document), because publishers' hosts send no CORS headers.
 * pdf.js is loaded on first use only, so it adds nothing to the main bundle.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  parseChartsIndex, chartsForAerodrome, chartDocumentProxyUrl,
  type ChartsIndex, type AerodromeCharts, type ChartEntry,
} from '@open-vfr/shared/chartsIndex'
import { countryFileUrl, countryDatasetFile } from '@open-vfr/shared/countryData'
import { loadOptionalJson } from './optionalJson'
import { API_BASE_URL } from './env'
import { useActiveCountries } from './countryData'
import type { PDFDocumentProxy } from 'pdfjs-dist'

// ── Charts index ────────────────────────────────────────────────────────────

const indexCache = new Map<string, Promise<ChartsIndex | null>>()

/** One country's charts index, or null when the deployment has none. */
export function loadChartsIndex(country: string): Promise<ChartsIndex | null> {
  return loadOptionalJson(indexCache, countryFileUrl(countryDatasetFile(country, 'charts')), parseChartsIndex)   // optional file: a 404 is normal
}

/** Charts for one aerodrome across the active countries (null = none). */
export function useAerodromeCharts(icao: string | undefined, enabled: boolean): AerodromeCharts | null {
  const { countries, key } = useActiveCountries()
  const [result, setResult] = useState<AerodromeCharts | null>(null)
  useEffect(() => {
    setResult(null)
    if (!enabled || !icao) return
    let cancelled = false
    Promise.all(countries.map(loadChartsIndex)).then((idx) => {
      if (!cancelled) setResult(chartsForAerodrome(idx.filter((i): i is ChartsIndex => !!i), icao))
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icao, enabled, key])
  return result
}

// ── PDF documents ───────────────────────────────────────────────────────────

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null

function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      return pdfjs
    })
    pdfjsPromise.catch(() => { pdfjsPromise = null })
  }
  return pdfjsPromise
}

export class ChartDocumentError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

const DOC_CACHE_MAX = 6
const docCache = new Map<string, Promise<PDFDocumentProxy>>()

/** The official document of one chart edition, fetched through the API
 *  pass-through (by country and chart id); a few recently used documents
 *  stay open. */
export function loadChartDocument(country: string, chartId: string): Promise<PDFDocumentProxy> {
  const cacheKey = `${country}/${chartId}`
  const hit = docCache.get(cacheKey)
  if (hit) {
    docCache.delete(cacheKey)
    docCache.set(cacheKey, hit)
    return hit
  }
  const p = (async () => {
    const res = await fetch(chartDocumentProxyUrl(API_BASE_URL, country, chartId), { credentials: 'include' })
    if (!res.ok) {
      const msg = res.status === 401 ? 'Sign in to view charts in the app.'
        : res.status === 429 ? 'Too many chart requests, try again later.'
        : res.status === 404 ? 'In-app viewing is not available for this chart.'
        : 'The chart could not be loaded.'
      throw new ChartDocumentError(msg, res.status)
    }
    const data = new Uint8Array(await res.arrayBuffer())
    const pdfjs = await loadPdfjs()
    return pdfjs.getDocument({ data }).promise
  })()
  p.catch(() => { if (docCache.get(cacheKey) === p) docCache.delete(cacheKey) })
  docCache.set(cacheKey, p)
  while (docCache.size > DOC_CACHE_MAX) {
    const [oldest, op] = docCache.entries().next().value as [string, Promise<PDFDocumentProxy>]
    docCache.delete(oldest)
    op.then(d => d.loadingTask.destroy()).catch(() => {})
  }
  return p
}

/** The most pixels a chart canvas may have (width x height): ~64 MB of RGBA. Beyond it the canvas is drawn smaller and scaled up by CSS. */
export const MAX_CANVAS_PIXELS = 16_000_000

export interface RenderOptions {
  maxPx: number
  crop?: [number, number, number, number]
  /** Absolute scale (canvas px per PDF point); else `fitCssWidth` x `zoom` x devicePixelRatio, else `maxPx`. */
  scale?: number
  /** Fit the page to this CSS width, times `zoom`: the page is only looked up once, here. */
  fitCssWidth?: number
  zoom?: number
  /** Cancels the pdf.js render task (it would otherwise keep the canvas busy and a second render on it is refused). */
  signal?: AbortSignal
}

/**
 * Render one page (or the crop [left, top, right, bottom] as page fractions) into `canvas`. The canvas never exceeds
 * MAX_CANVAS_PIXELS. Aborting `signal` cancels the render and rejects with an AbortError, after pdf.js has let go of the canvas.
 * Returns the canvas size and the CSS width the page should be shown at when `fitCssWidth` was given.
 */
export async function renderChartPage(
  doc: PDFDocumentProxy, pageNumber: number, canvas: HTMLCanvasElement, opts: RenderOptions,
): Promise<{ width: number; height: number; cssWidth: number }> {
  const abort = () => new DOMException('Aborted', 'AbortError')
  if (opts.signal?.aborted) throw abort()
  const page = await doc.getPage(pageNumber)
  if (opts.signal?.aborted) throw abort()
  const base = page.getViewport({ scale: 1 })
  const [l, t, r, b] = opts.crop ?? [0, 0, 1, 1]
  const cropW = base.width * (r - l)
  const cropH = base.height * (b - t)
  const dpr = window.devicePixelRatio || 1
  let scale = opts.scale ?? (opts.fitCssWidth !== undefined
    ? (opts.fitCssWidth / base.width) * (opts.zoom ?? 1) * dpr
    : Math.min(opts.maxPx / Math.max(cropW, cropH), 6))
  const cssWidth = Math.round((cropW * scale) / dpr)
  scale = Math.min(scale, Math.sqrt(MAX_CANVAS_PIXELS / (cropW * cropH)))
  const viewport = page.getViewport({ scale, offsetX: -base.width * l * scale, offsetY: -base.height * t * scale })
  canvas.width = Math.max(1, Math.round(cropW * scale))
  canvas.height = Math.max(1, Math.round(cropH * scale))
  const task = page.render({ canvas, viewport })
  const onAbort = () => task.cancel()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await task.promise
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'RenderingCancelledException') throw abort()
    throw err
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
  return { width: canvas.width, height: canvas.height, cssWidth }
}

// ── UI state shared by the popup, viewer and map overlay ───────────────────

export interface ChartSelection {
  chart: ChartEntry
  /** Country of the charts index (the API resolves the document per country). */
  country: string
  icao: string
  attribution: string
  cycle: string | null
}

interface ChartUiState {
  overlay: ChartSelection | null
  overlayOpacity: number
  viewer: ChartSelection | null
}

let state: ChartUiState = { overlay: null, overlayOpacity: 0.85, viewer: null }
const listeners = new Set<() => void>()
function set(patch: Partial<ChartUiState>) {
  state = { ...state, ...patch }
  listeners.forEach(l => l())
}

export const chartUi = {
  showOverlay: (s: ChartSelection) => set({ overlay: s }),
  toggleOverlay: (s: ChartSelection) => set({ overlay: state.overlay?.chart.id === s.chart.id ? null : s }),
  closeOverlay: () => set({ overlay: null }),
  setOpacity: (v: number) => set({ overlayOpacity: Math.min(1, Math.max(0.1, v)) }),
  openViewer: (s: ChartSelection) => set({ viewer: s }),
  closeViewer: () => set({ viewer: null }),
}

export function useChartUi(): ChartUiState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => state,
  )
}
