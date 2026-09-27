import { useEffect, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { ATTRIBUTION_SOURCES } from '@open-vfr/shared/attributionSources'
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
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.686
/** MapLibre's world size at zoom 0, in CSS px. */
const TILE_SIZE_PX = 512
/** One CSS px at the CSS reference 96 dpi, in metres. */
const CSS_PX_M = 0.0254 / 96
const MAX_BAR_PX = 110
const M_PER_NM = 1852

/** Largest 1/2/5 × 10^n value ≤ v. */
function niceFloor(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const d = v / p
  return (d >= 5 ? 5 : d >= 2 ? 2 : 1) * p
}

function fmtRatio(r: number): string {
  if (r >= 1e6) return `1:${(r / 1e6).toFixed(r >= 1e7 ? 0 : 1)}M`
  if (r >= 1e3) return `1:${Math.round(r / 1e3)}k`
  return `1:${Math.round(r)}`
}

interface ScaleState { barPx: number; label: string; ratio: string }

function computeScale(map: maplibregl.Map, nm: boolean): ScaleState {
  const lat = map.getCenter().lat
  const mPerPx = (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE_PX * Math.pow(2, map.getZoom()))
  const unitM = nm ? M_PER_NM : 1000
  const maxUnits = (mPerPx * MAX_BAR_PX) / unitM
  let value: number, unit: string, valueM: number
  if (!nm && maxUnits < 1) {
    // Sub-kilometre: fall back to metres.
    value = niceFloor(mPerPx * MAX_BAR_PX); unit = 'm'; valueM = value
  } else {
    value = niceFloor(maxUnits); unit = nm ? 'NM' : 'km'; valueM = value * unitM
  }
  return {
    barPx: Math.max(1, Math.round(valueM / mPerPx)),
    label: `${value} ${unit}`,
    ratio: fmtRatio(mPerPx / CSS_PX_M),
  }
}

export default function MapInfoBar({ map, ceilingFt, units }: Props) {
  const nm = units.distance === 'nm'
  const [scale, setScale] = useState<ScaleState | null>(null)
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
