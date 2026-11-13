import { useUnreviewedShown, setUnreviewedPreference } from '../utils/unreviewedCurated'
import css from './UnreviewedBanner.module.css'

/** Shown while an admin has unreviewed curated data and charts switched on: it must never be mistaken for the approved map. */
export default function UnreviewedBanner() {
  const on = useUnreviewedShown()
  if (!on) return null
  return (
    <div className={css.banner} role="status" data-testid="unreviewed-banner">
      <span>Showing unreviewed curated data and unreleased charts (admin)</span>
      <button className={css.off} onClick={() => setUnreviewedPreference(false)}>Approved only</button>
    </div>
  )
}
