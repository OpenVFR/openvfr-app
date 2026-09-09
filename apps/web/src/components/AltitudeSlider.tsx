import { useEffect, useRef } from 'react'
import css from './AltitudeSlider.module.css'

// Snap points in feet that make sense for VFR pilots.
// Labels show the aeronautical equivalent where relevant.
const SNAP_POINTS: { ft: number; label: string }[] = [
  { ft: 500,   label: '500 ft' },
  { ft: 1000,  label: '1 000 ft' },
  { ft: 1500,  label: '1 500 ft' },
  { ft: 2000,  label: '2 000 ft' },
  { ft: 3000,  label: '3 000 ft' },
  { ft: 4000,  label: '4 000 ft' },
  { ft: 4500,  label: '4 500 ft' },
  { ft: 5000,  label: '5 000 ft' },
  { ft: 6500,  label: 'FL065' },
  { ft: 7500,  label: '7 500 ft' },
  { ft: 9500,  label: 'FL095' },
  { ft: 12500, label: 'FL125' },
  { ft: 19500, label: 'FL195' },
  { ft: 66000, label: 'Unlimited' },
]

const MAX_FT = SNAP_POINTS[SNAP_POINTS.length - 1].ft

/** Convert a slider 0–100 position to a ft value (log-ish via snap points). */
function posToFt(pos: number): number {
  const idx = Math.round((pos / 100) * (SNAP_POINTS.length - 1))
  return SNAP_POINTS[Math.min(idx, SNAP_POINTS.length - 1)].ft
}

/** Convert a ft value to a slider 0–100 position. */
function ftToPos(ft: number): number {
  const idx = SNAP_POINTS.findIndex((p) => p.ft >= ft)
  if (idx < 0) return 100
  return Math.round((idx / (SNAP_POINTS.length - 1)) * 100)
}

function ftToLabel(ft: number): string {
  const snap = SNAP_POINTS.find((p) => p.ft === ft)
  return snap?.label ?? `${ft.toLocaleString()} ft`
}

interface Props {
  ceilingFt: number
  onChange: (ft: number) => void
}

export default function AltitudeSlider({ ceilingFt, onChange }: Props) {
  const pos = ftToPos(ceilingFt)
  const trackRef = useRef<HTMLInputElement>(null)

  // Update the CSS custom property on the input element so the track
  // fill gradient tracks the thumb position. This avoids inline style prop.
  useEffect(() => {
    trackRef.current?.style.setProperty('--progress', `${pos}%`)
  }, [pos])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(posToFt(Number(e.target.value)))
  }

  const isUnlimited = ceilingFt >= MAX_FT
  const label = ftToLabel(ceilingFt)

  return (
    <div className={css.panel}>
      <div className={css.header}>
        <span className={css.title}>Ceiling</span>
        <span className={css.value} data-unlimited={isUnlimited}>
          {label}
        </span>
      </div>
      <div className={css.trackWrap}>
        <input
          ref={trackRef}
          type="range"
          min={0}
          max={100}
          step={1}
          value={pos}
          onChange={handleChange}
          className={css.track}
          aria-label={`Altitude ceiling: ${label}`}
        />
        {/* Default tick mark at FL095 — position is hardcoded in CSS */}
        <span className={css.defaultMark} title="Default (FL095)" />
      </div>
      <div className={css.legend}>
        <span>500 ft</span>
        <span>FL095</span>
        <span>Unlimited</span>
      </div>
    </div>
  )
}
