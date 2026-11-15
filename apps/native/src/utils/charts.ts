/**
 * Official charts on native (experimental): the aerodrome's published charts from the deployment's charts index, the document opened
 * in the app, and -- for a georeferenced chart -- drawn on the map. Same index, rules and look as the web app
 * (apps/web/src/utils/charts.ts), with these differences:
 *
 *  - Only the PUBLIC index (`<cc>-charts.public.json`: released airfields) is ever read. There is no "include unreviewed" on native.
 *  - The device fetches the publisher's PDF itself (no CORS here), straight to a file: nothing goes through the API, so the API
 *    holds no document in memory. The URL comes from the index, must pass checkChartDocumentUrl, and the file must be a PDF within
 *    the size cap. At most CHART_DOCUMENT_KEEP documents are kept (oldest used go first).
 *  - Pages are drawn by a small native module (modules/openvfr-pdf: Android PdfRenderer / iOS PDFKit). It is optional: a build
 *    without it still lists the charts and opens each at the publisher (`pdfRenderingAvailable`).
 *  - Whether charts are offered at all follows the API's /api/charts/config (a deployment may refuse everyone but admins; native
 *    has no admin concept, so then it offers none).
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Directory, File, FileMode, Paths } from 'expo-file-system'
import {
  chartsForAerodrome, findChart, parseChartsIndex,
  type AerodromeCharts, type ChartEntry, type ChartsIndex,
} from '@open-vfr/shared/chartsIndex'
import { countryDatasetFile, getActiveCountries, onActiveCountriesChange } from '@open-vfr/shared/countryData'
import {
  CHART_DOCUMENT_KEEP, CHART_DOCUMENT_MAX_BYTES, checkChartDocumentUrl, chartDocumentFileName, documentHostSet, documentsToEvict,
  looksLikePdf, renderSize,
} from '@open-vfr/shared/chartDocument'
import { API_BASE, tileFileUrlReady } from '../config'
import { OpenVfrPdf } from '../../modules/openvfr-pdf'

/** True when this build can draw PDF pages in the app (the native module is linked). */
export const pdfRenderingAvailable = OpenVfrPdf != null

export class ChartDocumentError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

// ── Whether charts are offered ──────────────────────────────────────────────

let configPromise: Promise<boolean> | null = null
/** The API's `adminOnly`: when in doubt (older API without the route, errors) charts stay hidden; an error is asked again next time. */
function loadAdminOnly(): Promise<boolean> {
  if (!configPromise) {
    const p: Promise<boolean> = fetch(`${API_BASE}/api/charts/config`)
      .then(async (r) => {
        if (r.ok) return !!((await r.json()) as { adminOnly?: unknown }).adminOnly
        if (r.status === 404) return true
        throw new Error(`HTTP ${r.status}`)
      })
      .catch(() => { if (configPromise === p) configPromise = null; return true })
    configPromise = p
  }
  return configPromise
}

/** Whether the charts section, viewer and map overlay are offered to this user. */
export function useChartsEnabled(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    void loadAdminOnly().then(adminOnly => { if (!cancelled) setOpen(!adminOnly) })
    return () => { cancelled = true }
  }, [])
  return open
}

// ── The charts index (public only) ──────────────────────────────────────────

const indexCache = new Map<string, Promise<ChartsIndex | null>>()

/** One country's public charts index, or null when there is none. A missing file (4xx) is remembered; an error is not (retried). */
export async function loadChartsIndex(country: string): Promise<ChartsIndex | null> {
  const url = await tileFileUrlReady(countryDatasetFile(country, 'charts'))
  const hit = indexCache.get(url)
  if (hit) return hit
  const p: Promise<ChartsIndex | null> = fetch(url)
    .then(async (r) => {
      if (r.ok) return parseChartsIndex(await r.json())
      if (r.status >= 400 && r.status < 500) return null
      throw new Error(`HTTP ${r.status}`)
    })
    .catch((err) => {
      if (indexCache.get(url) === p) indexCache.delete(url)
      console.warn('[charts] index:', err instanceof Error ? err.message : err)
      return null
    })
  indexCache.set(url, p)
  return p
}

/** Charts of one aerodrome across the active countries (null = none). */
export function useAerodromeCharts(icao: string | undefined, enabled: boolean): AerodromeCharts | null {
  const [countries, setCountries] = useState<string[]>(getActiveCountries)
  useEffect(() => onActiveCountriesChange(setCountries), [])
  const [result, setResult] = useState<AerodromeCharts | null>(null)
  const key = countries.join(',')
  useEffect(() => {
    setResult(null)
    if (!enabled || !icao) return
    let cancelled = false
    void Promise.all(countries.map(loadChartsIndex)).then((all) => {
      if (!cancelled) setResult(chartsForAerodrome(all.filter((i): i is ChartsIndex => !!i), icao))
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icao, enabled, key])
  return result
}

// ── Documents ───────────────────────────────────────────────────────────────

export interface ChartSelection {
  chart: ChartEntry
  country: string
  icao: string
  attribution: string
  cycle: string | null
}

const dirOf = (name: string): Directory => {
  const d = new Directory(Paths.cache, name)
  if (!d.exists) d.create({ intermediates: true })
  return d
}
const docsDir = () => dirOf('ovfr-charts')
const rendersDir = () => dirOf('ovfr-charts-render')

const USAGE_FILE = 'usage.json'
function readUsage(): Record<string, number> {
  const f = new File(docsDir(), USAGE_FILE)
  if (!f.exists) return {}
  try { return JSON.parse(f.textSync()) as Record<string, number> } catch { return {} }
}
function writeUsage(u: Record<string, number>): void {
  const f = new File(docsDir(), USAGE_FILE)
  if (f.exists) f.delete()
  f.write(JSON.stringify(u))
}

/** Marks a document as just used and deletes the least recently used beyond CHART_DOCUMENT_KEEP. */
function touchAndEvict(name: string): void {
  try {
    const usage = readUsage()
    usage[name] = Date.now()
    const dir = docsDir()
    const present = dir.list().filter((e): e is File => e instanceof File && e.name.endsWith('.pdf')).map(e => e.name)
    for (const gone of Object.keys(usage)) if (!present.includes(gone)) delete usage[gone]
    for (const victim of documentsToEvict(present.map(n => ({ name: n, modified: usage[n] ?? 0 })), CHART_DOCUMENT_KEEP)) {
      try { new File(dir, victim).delete() } catch { /* already gone */ }
      delete usage[victim]
    }
    writeUsage(usage)
  } catch (err) {
    console.warn('[charts] cache upkeep failed:', err instanceof Error ? err.message : err)
  }
}

/** One download per chart, shared by everyone who asks (the viewer and the map overlay): it has its own abort controller and is
 *  aborted only when the last caller has left, so one caller leaving never cancels what another still waits for. */
interface Download { promise: Promise<string>; guard: AbortController; callers: number }
const downloads = new Map<string, Download>()

function fileLooksLikePdf(f: File): boolean {
  try {
    const h = f.open(FileMode.ReadOnly)
    try { return looksLikePdf(h.readBytesSync(5)) } finally { h.close() }
  } catch { return false }
}

/**
 * The local file (uri) of a chart's official document: the cached copy when it is still the right one, else downloaded from the
 * publisher. The URL is taken from the published index (not from `sel`) and checked; the download is streamed to disk.
 */
export function ensureChartDocument(sel: ChartSelection, signal?: AbortSignal): Promise<string> {
  const k = `${sel.country}/${sel.chart.id}`
  let entry = downloads.get(k)
  if (!entry) {
    const created: Download = { promise: Promise.resolve(''), guard: new AbortController(), callers: 0 }
    created.promise = fetchChartDocument(sel, created.guard)
      .finally(() => { if (downloads.get(k) === created) downloads.delete(k) })       // gone before any caller resumes: the next call re-checks the file
    downloads.set(k, created)
    entry = created
  }
  const dl = entry
  dl.callers++
  return new Promise<string>((resolve, reject) => {
    let left = false
    const leave = (): boolean => {
      if (left) return false
      left = true
      signal?.removeEventListener('abort', onAbort)
      dl.callers--
      return true
    }
    const onAbort = () => {
      if (!leave()) return
      if (dl.callers === 0) dl.guard.abort()
      reject(new DOMException('The chart request was cancelled.', 'AbortError'))
    }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    dl.promise.then(uri => { if (leave()) resolve(uri) }, err => { if (leave()) reject(err) })
  })
}

async function fetchChartDocument(sel: ChartSelection, guard: AbortController): Promise<string> {
  const index = await loadChartsIndex(sel.country)
  const listed = index ? findChart(index, sel.chart.id) : null
  if (!index || !listed || !index.display.document) throw new ChartDocumentError('This chart is not available in the app.', 404)
  const checked = checkChartDocumentUrl(listed.chart.url, documentHostSet(index))
  if ('error' in checked) throw new ChartDocumentError('This chart cannot be opened in the app.', 404)
  const name = chartDocumentFileName(sel.country, listed.chart)
  if (!name) throw new ChartDocumentError('This chart cannot be opened in the app.', 404)
  const dest = new File(docsDir(), name)
  const expected = listed.chart.bytes
  if (dest.exists && (dest.size ?? 0) > 0 && (!expected || dest.size === expected) && fileLooksLikePdf(dest)) {
    touchAndEvict(name)
    return dest.uri
  }
  if (dest.exists) dest.delete()
  // Stop a download that announces (or grows past) the cap, instead of filling the disk first and checking afterwards.
  let tooLarge = false
  try {
    await File.createDownloadTask(checked.url, dest, {
      signal: guard.signal,
      onProgress: ({ bytesWritten, totalBytes }) => {
        if (bytesWritten > CHART_DOCUMENT_MAX_BYTES || totalBytes > CHART_DOCUMENT_MAX_BYTES) { tooLarge = true; guard.abort() }
      },
    }).downloadAsync()
  } catch (err) {
    if (dest.exists) dest.delete()
    if (tooLarge) {
      console.warn(`[charts] ${checked.url}: larger than the ${CHART_DOCUMENT_MAX_BYTES} byte cap, download stopped`)
      throw new ChartDocumentError('This chart is too large to open in the app. Use “Open at the publisher”.')
    }
    if (guard.signal.aborted) throw err                               // every caller left: nobody is waiting for the answer
    throw new ChartDocumentError('The chart could not be downloaded. Check the connection and try again.')
  }
  const size = dest.exists ? (dest.size ?? 0) : 0
  const bad = size === 0 ? 'empty'
    : size > CHART_DOCUMENT_MAX_BYTES ? 'over the size cap'
    : expected && size !== expected ? 'not the edition the index lists'
    : !fileLooksLikePdf(dest) ? 'not a PDF' : null
  if (bad) {
    if (dest.exists) dest.delete()
    console.warn(`[charts] ${checked.url}: downloaded file is ${bad}`)
    throw new ChartDocumentError('The chart could not be opened (the document is not valid).')
  }
  touchAndEvict(name)
  return dest.uri
}

// ── Rendering a page ────────────────────────────────────────────────────────

export interface RenderedImage { uri: string; width: number; height: number; pageCount: number; pageWidthPt: number; pageHeightPt: number }

const rendered = new Map<string, Promise<RenderedImage>>()
const renderOrder: string[] = []
const RENDER_KEEP = 10
let rendersSwept = false

/**
 * One page (or the crop [left, top, right, bottom] as page fractions) of a local PDF as a PNG file, `targetWidthPx` wide (shrunk to
 * stay within the pixel cap). Same request = same file. Needs the native module (`pdfRenderingAvailable`).
 */
export function renderChartPage(
  docUri: string, page: number, targetWidthPx: number, crop: [number, number, number, number] = [0, 0, 1, 1],
): Promise<RenderedImage> {
  const native = OpenVfrPdf
  if (!native) return Promise.reject(new ChartDocumentError('This build cannot show charts in the app.'))
  const dir = rendersDir()
  if (!rendersSwept) {                                       // renders of an earlier session are not reused: they would only pile up
    rendersSwept = true
    for (const e of dir.list()) { try { e.delete() } catch { /* ignore */ } }
  }
  const stem = docUri.split('/').pop()?.replace(/\.pdf$/i, '') ?? 'chart'
  const key = `${stem}-p${page}-w${Math.round(targetWidthPx)}-c${crop.map(c => Math.round(c * 1000)).join('_')}`
  const hit = rendered.get(key)
  if (hit) return hit
  const p = (async () => {
    const first = await native.pageInfo(docUri, page)
    const size = renderSize(first.widthPt, first.heightPt, targetWidthPx, crop)
    const out = new File(dir, `${key}.png`)
    if (out.exists) out.delete()
    const r = await native.renderPage(docUri, page, size.width, size.height, crop, out.uri)
    return { uri: r.uri, width: r.width, height: r.height, pageCount: first.pageCount, pageWidthPt: r.pageWidthPt, pageHeightPt: r.pageHeightPt }
  })()
  rendered.set(key, p)
  renderOrder.push(key)
  p.catch(() => { rendered.delete(key) })
  while (renderOrder.length > RENDER_KEEP) {
    const old = renderOrder.shift()!
    rendered.delete(old)
    try { const f = new File(dir, `${old}.png`); if (f.exists) f.delete() } catch { /* ignore */ }
  }
  return p
}

// ── UI state shared by the aerodrome sheet, the viewer and the map overlay ──

interface ChartUiState {
  overlay: ChartSelection | null
  overlayOpacity: number
  viewer: ChartSelection | null
  /** Bumped when the camera should frame the overlay (a chart was just put on the map). */
  fitToken: number
}

let state: ChartUiState = { overlay: null, overlayOpacity: 0.85, viewer: null, fitToken: 0 }
const listeners = new Set<() => void>()
function set(patch: Partial<ChartUiState>) {
  state = { ...state, ...patch }
  listeners.forEach(l => l())
}

export const chartUi = {
  toggleOverlay: (s: ChartSelection) => set(state.overlay?.chart.id === s.chart.id
    ? { overlay: null } : { overlay: s, fitToken: state.fitToken + 1 }),
  closeOverlay: () => set({ overlay: null }),
  setOpacity: (v: number) => set({ overlayOpacity: Math.min(1, Math.max(0.1, v)) }),
  openViewer: (s: ChartSelection) => set({ viewer: s }),
  closeViewer: () => set({ viewer: null }),
}

export const getChartUiState = (): ChartUiState => state

export function useChartUi(): ChartUiState {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => state)
}

/** Only the fit counter, so a host that just frames the chart (the map) does not re-render on every opacity change. */
export function useChartFitToken(): number {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => state.fitToken)
}
