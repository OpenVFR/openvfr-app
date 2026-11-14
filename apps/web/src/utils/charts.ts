/**
 * Official charts: loads the optional per-country charts index and renders official chart PDFs with
 * pdf.js for the in-app viewer and the georeferenced map overlay.
 *
 * Two indexes (see @open-vfr/shared/chartsIndex): `<cc>-charts.public.json` = the released airfields' charts, read by every user;
 * `<cc>-charts.preview.json` = every airfield's, read only by an admin session with "Include unreviewed" on (the same switch as
 * the curated data), falling back to the public one. The document endpoint enforces the same split on the server.
 *
 * Document bytes come through the API's pass-through endpoint
 * (/api/charts/document), because publishers' hosts send no CORS headers.
 * pdf.js is loaded on first use only, so it adds nothing to the main bundle.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  parseChartsIndex, chartsForAerodrome, chartDocumentProxyUrl, findChart,
  type ChartsIndex, type AerodromeCharts, type ChartEntry,
} from '@open-vfr/shared/chartsIndex'
import { countryFileUrlReady, countryDatasetFile } from '@open-vfr/shared/countryData'
import { loadOptionalJson } from './optionalJson'
import { API_BASE_URL } from './env'
import { useActiveCountries } from './countryData'
import { useUnreviewedShown } from './unreviewedCurated'
import { useIsAdmin } from './adminAccess'
import type { PDFDocumentProxy } from 'pdfjs-dist'

// ── Charts config ───────────────────────────────────────────────────────────

/**
 * The deployment may refuse every non-admin (api CHART_DOCUMENT_ADMIN_ONLY): the api says so, so the UI does not offer charts
 * that every document request would refuse with 403. When in doubt, charts stay admin-only (the behaviour before the route
 * existed): a 404 (an older api without the route, or the document endpoint not mounted) is remembered as admin-only; any other
 * failure (5xx during a deploy, network) hides them this time and is asked again next time, never cached as "open".
 */
let configPromise: Promise<boolean> | null = null
function loadAdminOnly(): Promise<boolean> {
  if (!configPromise) {
    const p: Promise<boolean> = fetch(`${API_BASE_URL}/api/charts/config`, { credentials: 'same-origin' })
      .then(async (r) => {
        if (r.ok) return !!((await r.json()) as { adminOnly?: unknown }).adminOnly
        if (r.status === 404) return true
        throw new Error(`HTTP ${r.status}`)
      })
      .catch(() => { if (configPromise === p) configPromise = null; return true })          // transient: ask again next time
    configPromise = p
  }
  return configPromise
}

/**
 * Whether the charts section, viewer and map overlay are offered: to everyone (the public index lists released airfields' charts
 * only; the rest is admin-only, see loadChartsIndex), except on a deployment that refuses every non-admin.
 */
export function useChartsEnabled(): boolean {
  const admin = useIsAdmin()
  const [adminOnly, setAdminOnly] = useState<boolean | null>(null)
  useEffect(() => {
    if (admin) return
    let cancelled = false
    void loadAdminOnly().then(v => { if (!cancelled) setAdminOnly(v) })
    return () => { cancelled = true }
  }, [admin])
  return admin || adminOnly === false
}

// ── Charts index ────────────────────────────────────────────────────────────

const indexCache = new Map<string, Promise<ChartsIndex | null>>()

// Waits for the tile manifest first, so the index is fetched by its versioned URL (see countryFileUrlReady).
const indexUrl = (country: string, kind: 'charts' | 'chartsPreview') => countryFileUrlReady(countryDatasetFile(country, kind))

/** One country's public charts index (the released airfields), or null when the deployment has none. */
export async function loadChartsIndex(country: string): Promise<ChartsIndex | null> {
  return loadOptionalJson(indexCache, await indexUrl(country, 'charts'), parseChartsIndex)       // optional file: a 404 is normal
}

/**
 * What the charts section reads for one country. `preview` (an admin who switched on unreviewed data): the preview index (every
 * airfield), with the public one beside it so the section can tell which airfields are not released. A preview index that is
 * not published (a definite 4xx, remembered) falls back to the public one silently; one that failed to load (network or server
 * error: not remembered, retried next time) also falls back but is reported, so the admin is not told "all charts" by mistake.
 */
export async function loadChartsIndexes(country: string, preview: boolean):
  Promise<{ index: ChartsIndex | null; publicIndex: ChartsIndex | null; previewFailed: boolean }> {
  if (!preview) {
    const publicIndex = await loadChartsIndex(country)
    return { index: publicIndex, publicIndex, previewFailed: false }
  }
  const url = await indexUrl(country, 'chartsPreview')
  const [publicIndex, previewIndex] = await Promise.all([loadChartsIndex(country), loadOptionalJson(indexCache, url, parseChartsIndex)])
  return { index: previewIndex ?? publicIndex, publicIndex, previewFailed: !previewIndex && !indexCache.has(url) }
}

export interface AerodromeChartsView extends AerodromeCharts {
  /** Preview only: the airfield is not in the public index (not released): admins see it, nobody else. */
  unreleased: boolean
  /** Preview only: the preview index could not be loaded, so the public charts are shown. */
  previewFailed: boolean
}

/** Charts for one aerodrome across the active countries (null = none). */
export function useAerodromeCharts(icao: string | undefined, enabled: boolean): AerodromeChartsView | null {
  const { countries, key } = useActiveCountries()
  const preview = useUnreviewedShown()
  const [result, setResult] = useState<AerodromeChartsView | null>(null)
  useEffect(() => {
    setResult(null)
    if (!enabled || !icao) return
    let cancelled = false
    Promise.all(countries.map(c => loadChartsIndexes(c, preview))).then((all) => {
      if (cancelled) return
      const ad = chartsForAerodrome(all.map(a => a.index).filter((i): i is ChartsIndex => !!i), icao)
      if (!ad) { setResult(null); return }
      const inPublic = chartsForAerodrome(all.map(a => a.publicIndex).filter((i): i is ChartsIndex => !!i), icao) !== null
      setResult({ ...ad, unreleased: preview && !inPublic, previewFailed: preview && all.some(a => a.previewFailed) })
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icao, enabled, key, preview])
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
        : res.status === 403 ? 'In-app viewing of charts is not available for this account. Open the chart at the publisher instead.'
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

/** The current chart UI state outside React (tests, guards). */
export const getChartUiState = (): ChartUiState => state

export function useChartUi(): ChartUiState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => state,
  )
}

/** Drops a chart from the document cache (and releases pdf.js's hold on it). */
function forgetDocument(country: string, chartId: string) {
  const k = `${country}/${chartId}`
  const p = docCache.get(k)
  if (!p) return
  docCache.delete(k)
  p.then(d => d.loadingTask.destroy()).catch(() => {})
}

/**
 * Closes the chart overlay and the viewer when what they show is not a released airfield's chart: the admin switched "Include
 * unreviewed" off or signed out. A chart the public index still lists stays. The documents are forgotten too, so a preview-only
 * chart is not kept in memory.
 */
export async function closeUnreleasedCharts(): Promise<void> {
  for (const sel of [state.overlay, state.viewer]) {
    if (!sel) continue
    const idx = await loadChartsIndex(sel.country)
    if (idx && findChart(idx, sel.chart.id)) continue
    forgetDocument(sel.country, sel.chart.id)
    if (state.overlay?.chart.id === sel.chart.id) chartUi.closeOverlay()
    if (state.viewer?.chart.id === sel.chart.id) chartUi.closeViewer()
  }
}

/** Mount once next to the overlay and viewer: when unreviewed data turns off (switch, sign-out) the unreleased charts close. */
export function useChartAccessGuard(): void {
  const preview = useUnreviewedShown()
  useEffect(() => { if (!preview) void closeUnreleasedCharts() }, [preview])
}
