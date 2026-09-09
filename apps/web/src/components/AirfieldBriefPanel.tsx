import type { BriefAerodrome } from '../hooks/useAirfieldBrief'
import type { AerodromeFeatureProps } from './AerodromePopup'
import css from './AirfieldBriefPanel.module.css'

const SURFACE_LABEL: Record<string, string> = {
  ASPH: 'Asph',
  CONC: 'Conc',
  GRASS: 'Grass',
  SAND: 'Sand',
}

const PRIMARY_ORDER = ['TWR', 'AFIS', 'INFO', 'APP', 'RDO', 'COM']

function primaryFreq(props: AerodromeFeatureProps): string | null {
  for (const svc of PRIMARY_ORDER) {
    const m = props.frequencies.find(f => f.service === svc && f.freq_mhz != null)
    if (m) return m.freq_mhz!.toFixed(3)
  }
  if (props.frequencies.length > 0 && props.frequencies[0].freq_mhz != null) {
    return props.frequencies[0].freq_mhz!.toFixed(3)
  }
  return null
}

interface Props {
  brief:       BriefAerodrome
  onOpenFull:  (props: AerodromeFeatureProps, lat: number, lng: number) => void
  onClose:     () => void
}

export default function AirfieldBriefPanel({ brief, onOpenFull, onClose }: Props) {
  const { props } = brief
  const freq      = primaryFreq(props)

  return (
    <div className={css.panel}>
      {/* Header row */}
      <div className={css.header}>
        <button
          className={css.titleBtn}
          onClick={() => onOpenFull(props, brief.lat, brief.lng)}
          title="Open full aerodrome information"
        >
          <span className={css.icao}>{props.icao || props.name}</span>
          {props.icao && <span className={css.name}>{props.name}</span>}
        </button>
        <div className={css.meta}>
          {props.elevation_ft != null && (
            <span className={css.elev}>{props.elevation_ft} ft</span>
          )}
          <span className={css.dist}>{brief.distNm.toFixed(1)} NM</span>
        </div>
        <button className={css.close} onClick={onClose} aria-label="Close brief">×</button>
      </div>

      {/* Frequency row */}
      {freq && (
        <div className={css.freqRow}>
          <span className={css.freqLabel}>FREQ</span>
          <span className={css.freq}>{freq}</span>
          {props.ppr && <span className={css.pprBadge}>PPR</span>}
        </div>
      )}
      {!freq && props.ppr && (
        <div className={css.freqRow}>
          <span className={css.pprBadge}>PPR</span>
        </div>
      )}

      {/* Runway rows */}
      {props.runways.length > 0 && (
        <div className={css.runways}>
          {props.runways.map((rwy, i) => (
            <div key={i} className={css.rwyRow}>
              <span className={css.rwyDesig}>{rwy.designator}</span>
              <span className={css.rwyLen}>
                {rwy.length_m != null ? `${rwy.length_m} m` : '—'}
              </span>
              <span className={
                rwy.surface === 'GRASS' || rwy.surface === 'SAND'
                  ? css.surfGrass
                  : css.surf
              }>
                {SURFACE_LABEL[rwy.surface] ?? rwy.surface}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
