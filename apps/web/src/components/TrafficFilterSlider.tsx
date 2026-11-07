import { useEffect, useRef } from 'react'
import css from './AltitudeSlider.module.css'
import { TRAFFIC_VERT_FILTER_OPTIONS, type TrafficVertFilter } from '../db/useSettings'

/** Steps from tight to wide; the last one (0) is "All" = no filtering. */
const STEPS = TRAFFIC_VERT_FILTER_OPTIONS
const MAX_IDX = STEPS.length - 1

export function trafficFilterLabel(v: TrafficVertFilter): string {
  return v === 0 ? 'All' : `±${v.toLocaleString('en').replace(',', ' ')} ft`
}

interface Props {
  value: TrafficVertFilter
  onChange: (v: TrafficVertFilter) => void
  /** Flying mode: the filter is active. Otherwise all traffic is shown. */
  flying: boolean
}

/** Slider for the traffic vertical filter: hide traffic more than N ft above/below own altitude. */
export default function TrafficFilterSlider({ value, onChange, flying }: Props) {
  const found = STEPS.indexOf(value)
  const idx = found >= 0 ? found : STEPS.indexOf(5000)
  const pos = (idx / MAX_IDX) * 100
  const trackRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    trackRef.current?.style.setProperty('--progress', `${pos}%`)
  }, [pos])

  const label = trafficFilterLabel(value)
  return (
    <div className={css.panel}>
      <div className={css.header}>
        <span className={css.title}>Traffic vertical filter</span>
        <span className={css.value} data-unlimited={value === 0}>{label}</span>
      </div>
      <div className={css.trackWrap}>
        <input
          ref={trackRef}
          type="range"
          min={0}
          max={MAX_IDX}
          step={1}
          value={idx}
          onChange={(e) => onChange(STEPS[Number(e.target.value)])}
          className={css.track}
          aria-label={`Traffic vertical filter: ${label}`}
          title={value === 0 ? 'Show all traffic regardless of altitude' : `Hide traffic more than ${value.toLocaleString()} ft above or below current altitude`}
        />
      </div>
      <div className={css.legend}>
        <span>±1 000 ft</span>
        <span>All</span>
      </div>
      <div className={css.legend}>
        <span>{flying ? 'Hides traffic further than this above or below you.' : 'Not flying: all traffic is shown. The filter starts in flying mode.'}</span>
      </div>
    </div>
  )
}
