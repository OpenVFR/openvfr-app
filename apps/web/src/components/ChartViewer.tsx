/**
 * In-app viewer for an official chart document (experimental,
 * EXPERIMENTAL_CHARTS). Renders the publisher's PDF page by page with pdf.js;
 * the document itself is never stored or altered. "Open original" always
 * links to the publisher.
 */
import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { CHART_KIND_LABEL } from '@open-vfr/shared/chartsIndex'
import { chartUi, loadChartDocument, renderChartPage, useChartUi, ChartDocumentError } from '../utils/charts'
import css from './ChartViewer.module.css'

const ZOOMS = [1, 1.5, 2, 3]

export default function ChartViewer() {
  const { viewer } = useChartUi()
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(0)
  const [rendering, setRendering] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDoc(null); setError(null); setPage(1); setZoom(0)
    if (!viewer) return
    let cancelled = false
    loadChartDocument(viewer.chart.url)
      .then(d => { if (!cancelled) setDoc(d) })
      .catch(e => { if (!cancelled) setError(e instanceof ChartDocumentError ? e.message : 'The chart could not be loaded.') })
    return () => { cancelled = true }
  }, [viewer])

  useEffect(() => {
    if (!doc || !canvasRef.current || !bodyRef.current) return
    let cancelled = false
    // clientWidth already excludes a vertical scrollbar; minus the padding,
    // plus a little room so fit-width never shows a horizontal one.
    const width = bodyRef.current.clientWidth - 16 - 18
    setRendering(true)
    // Fit the page width, then zoom; device pixels for a sharp result.
    doc.getPage(page).then(async (p) => {
      const base = p.getViewport({ scale: 1 })
      const scale = (width / base.width) * ZOOMS[zoom]! * (window.devicePixelRatio || 1)
      if (cancelled || !canvasRef.current) return
      await renderChartPage(doc, page, canvasRef.current, { maxPx: 1e9, scale })
      canvasRef.current.style.width = `${Math.round(base.width * scale / (window.devicePixelRatio || 1))}px`
    }).catch(() => { if (!cancelled) setError('The page could not be rendered.') })
      .finally(() => { if (!cancelled) setRendering(false) })
    return () => { cancelled = true }
  }, [doc, page, zoom])

  useEffect(() => {
    if (!viewer) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') chartUi.closeViewer() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer])

  if (!viewer) return null
  const pages = doc?.numPages ?? 0
  const georef = viewer.chart.georef

  return (
    <div className={css.scrim} onClick={chartUi.closeViewer}>
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label={viewer.chart.title} onClick={e => e.stopPropagation()}>
        <div className={css.header}>
          <div className={css.titleBlock}>
            <div className={css.title}>{viewer.icao} · {viewer.chart.title}</div>
            <div className={css.subtitle}>
              {CHART_KIND_LABEL[viewer.chart.kind]} · {viewer.attribution}{viewer.cycle ? ` · effective ${viewer.cycle}` : ''}
            </div>
          </div>
          <div className={css.tools}>
            {pages > 1 && (
              <>
                <button className={css.btn} disabled={page <= 1} onClick={() => setPage(p => p - 1)} aria-label="Previous page">‹</button>
                <span className={css.pageNo}>{page}/{pages}</span>
                <button className={css.btn} disabled={page >= pages} onClick={() => setPage(p => p + 1)} aria-label="Next page">›</button>
              </>
            )}
            <button className={css.btn} disabled={zoom === 0} onClick={() => setZoom(z => z - 1)} aria-label="Zoom out">−</button>
            <button className={css.btn} disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom(z => z + 1)} aria-label="Zoom in">+</button>
            {georef && (
              <button className={css.btn} onClick={() => { chartUi.showOverlay(viewer); chartUi.closeViewer() }}>
                Show on map
              </button>
            )}
            <a className={css.btn} href={viewer.chart.url} target="_blank" rel="noopener noreferrer">Open original</a>
            <button className={css.btn} onClick={chartUi.closeViewer} aria-label="Close">✕</button>
          </div>
        </div>
        <div className={css.body} ref={bodyRef}>
          {error && <div className={css.message}>{error}</div>}
          {!error && !doc && <div className={css.message}>Loading chart…</div>}
          <canvas ref={canvasRef} className={`${css.canvas} ${rendering || !doc ? css.canvasBusy : ''}`} />
        </div>
      </div>
    </div>
  )
}
