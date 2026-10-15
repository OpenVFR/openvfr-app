/**
 * Charts section of the aerodrome popup (experimental, EXPERIMENTAL_CHARTS):
 * the aerodrome's official published charts from the deployment's charts
 * index. Each chart opens at the publisher, in the in-app viewer, and -- when
 * it is georeferenced -- on the map. Renders nothing when there are no charts.
 */
import { useState } from 'react'
import {
  CHART_KIND_LABEL, VFR_CHART_KINDS, type AerodromeCharts, type ChartEntry,
} from '@open-vfr/shared/chartsIndex'
import { chartUi, useAerodromeCharts, useChartUi, type ChartSelection } from '../utils/charts'
import { EXPERIMENTAL_CHARTS } from '../utils/env'
import css from './ChartsSection.module.css'

interface Props {
  icao: string
  /** Section wrapper/title classes of the host popup, so it matches its siblings. */
  sectionClass: string
  titleClass: string
  /** Viewer/overlay fetch through the API, which requires a session. */
  authed: boolean
}

function ChartRow({ chart, ad, authed }: { chart: ChartEntry; ad: AerodromeCharts; authed: boolean }) {
  const ui = useChartUi()
  const sel: ChartSelection = { chart, icao: ad.icao, attribution: ad.source.attribution, cycle: ad.cycle }
  const onMap = ui.overlay?.chart.id === chart.id
  const canView = ad.display.document && authed
  const canOverlay = ad.display.overlay && !!chart.georef && authed
  return (
    <li className={css.row}>
      <span className={css.kind} title={CHART_KIND_LABEL[chart.kind]}>{chart.kind}</span>
      {canView ? (
        <button className={css.title} onClick={() => chartUi.openViewer(sel)} title="View chart">
          {chart.title}
        </button>
      ) : (
        <a className={css.title} href={chart.url} target="_blank" rel="noopener noreferrer">{chart.title}</a>
      )}
      <span className={css.actions}>
        {canOverlay && (
          <button
            className={`${css.iconBtn} ${onMap ? css.iconBtnActive : ''}`}
            onClick={() => chartUi.toggleOverlay(sel)}
            aria-pressed={onMap}
            aria-label={onMap ? 'Remove chart from map' : 'Show chart on map'}
            title={onMap ? 'Remove from map' : 'Show on map'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" />
            </svg>
          </button>
        )}
        <a
          className={css.iconBtn}
          href={chart.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open the official document"
          title="Open the official document"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
          </svg>
        </a>
      </span>
    </li>
  )
}

export default function ChartsSection({ icao, sectionClass, titleClass, authed }: Props) {
  const ad = useAerodromeCharts(icao, EXPERIMENTAL_CHARTS)
  const [showAll, setShowAll] = useState(false)
  if (!EXPERIMENTAL_CHARTS || !ad || ad.charts.length === 0) return null
  const vfr = ad.charts.filter(c => VFR_CHART_KINDS.has(c.kind))
  const rest = ad.charts.filter(c => !VFR_CHART_KINDS.has(c.kind))
  const shown = showAll || vfr.length === 0 ? ad.charts : vfr

  return (
    <div className={sectionClass}>
      <div className={titleClass}>Charts</div>
      <ul className={css.list}>
        {shown.map(c => <ChartRow key={c.id} chart={c} ad={ad} authed={authed} />)}
      </ul>
      {rest.length > 0 && vfr.length > 0 && (
        <button className={css.more} onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Fewer charts' : `More charts (${rest.length})`}
        </button>
      )}
      {!authed && (ad.display.document || ad.display.overlay) && (
        <div className={css.note}>Sign in to view charts in the app and on the map.</div>
      )}
      <div className={css.source}>
        {ad.infoUrl
          ? <a href={ad.infoUrl} target="_blank" rel="noopener noreferrer">{ad.source.attribution}</a>
          : ad.source.attribution}
        {ad.cycle && <> · effective {ad.cycle}</>}
        <span className={css.verify}> · always check the official publication</span>
      </div>
    </div>
  )
}
