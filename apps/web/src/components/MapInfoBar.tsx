import { useEffect, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { ATTRIBUTION_SOURCES } from '@open-vfr/shared/attributionSources'
import { computeMapScale, type MapScale } from '@open-vfr/shared/mapScale'
import { MAX_FT, ftToLabel } from './AltitudeSlider'
import type { Units } from '../utils/units'
import css from './MapInfoBar.module.css'

/**
 * Bottom-right map status pill: info (i) button, active airspace altitude
 * band, scale bar, and representative-fraction scale (1:N). Replaces the
 * separate MapLibre ScaleControl, ceiling chip and compact attribution
 * control with one compact element. The (i) opens the same curated
 * "Map data & attribution" list native's AviationMap shows
 * (@open-vfr/shared/attributionSources).
 */

interface Props {
  map: maplibregl.Map | null
  ceilingFt: number
  units: Units
  /** Altitude the wind-arrows overlay shows, e.g. "WIND 4,500 ft PLAN"; omit when the layer is off. */
  windLabel?: string
  /** True while the pilot forced ground wind; the label is a button that toggles it. */
  windSurface?: boolean
  onToggleWindSurface?: () => void
}

const MAX_BAR_PX = 110

function computeScale(map: maplibregl.Map, nm: boolean): MapScale {
  return computeMapScale(map.getCenter().lat, map.getZoom(), nm, MAX_BAR_PX)
}

export default function MapInfoBar({ map, ceilingFt, units, windLabel, windSurface, onToggleWindSurface }: Props) {
  const nm = units.distance === 'nm'
  const [scale, setScale] = useState<MapScale | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)

  useEffect(() => {
    if (!map) return
    let raf = 0
    const update = () => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; setScale(computeScale(map, nm)) })
    }
    setScale(computeScale(map, nm))
    map.on('move', update)
    map.on('resize', update)
    return () => {
      map.off('move', update)
      map.off('resize', update)
      cancelAnimationFrame(raf)
    }
  }, [map, nm])

  useEffect(() => {
    if (!infoOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setInfoOpen(false) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [infoOpen])

  const unlimited = ceilingFt >= MAX_FT
  const altLabel = `SFC \u2013 ${unlimited ? 'UNL' : ftToLabel(ceilingFt)}`

  return (
    <>
      <div className={css.bar}>
        <button
          type="button"
          className={css.infoBtn}
          onClick={() => setInfoOpen(true)}
          title="Map data & attribution"
          aria-label="Map data & attribution"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
          </svg>
        </button>
        <span
          className={`${css.alt}${unlimited ? '' : ` ${css.altFiltered}`}`}
          title="Airspace altitude filter — airspace starting above this is hidden. Change in Layers → Altitude Filter."
        >
          {altLabel}
        </span>
        {windLabel && (
          <button
            type="button"
            className={`${css.windBtn} ${windSurface ? css.altFiltered : ''}`}
            onClick={onToggleWindSurface}
            title={windSurface
              ? 'Wind arrows show ground wind. Click to follow your altitude / the planned route altitude.'
              : 'Wind arrows follow your altitude, otherwise the planned route altitude. Click to show ground wind instead.'}
          >
            {windLabel}
          </button>
        )}
        {scale && (
          <>
            <span className={css.scale} title="Map scale at the map centre">
              <span className={css.scaleBar} style={{ width: scale.barPx }} />
              <span className={css.scaleLabel}>{scale.label}</span>
            </span>
            <span className={css.ratio} title="Approximate map scale at the map centre">{scale.ratio}</span>
          </>
        )}
      </div>

      {infoOpen && (
        <div className={css.backdrop} onClick={() => setInfoOpen(false)}>
          <div
            className={css.card}
            role="dialog"
            aria-modal="true"
            aria-labelledby="map-info-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div id="map-info-title" className={css.title}>Map data &amp; attribution</div>
            <div className={css.list}>
              {ATTRIBUTION_SOURCES.map((s) => (
                <a key={s.name} className={css.row} href={s.url} target="_blank" rel="noopener noreferrer">
                  <span className={css.rowName}>{s.name}</span>
                  <span className={css.rowNote}>{s.note}</span>
                </a>
              ))}
            </div>
            <button type="button" className={css.closeBtn} onClick={() => setInfoOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </>
  )
}
