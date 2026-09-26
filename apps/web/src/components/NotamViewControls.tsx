/**
 * Compact NOTAM list controls: Short / Full / Raw text toggle + "VFR only"
 * filter chip. Both backed by useNotamPrefs, so every NOTAM list in the app
 * follows the same choice.
 */
import type { NotamTextView } from '@open-vfr/shared/notamIcaoFormat'
import { useNotamPrefs } from '../hooks/useNotamPrefs'
import css from './NotamViewControls.module.css'

const VIEWS: { v: NotamTextView; label: string; title: string }[] = [
  { v: 'short', label: 'Short', title: 'Decoded subject and first sentence' },
  { v: 'full',  label: 'Full',  title: 'Full text with validity, schedule and vertical limits' },
  { v: 'raw',   label: 'Raw',   title: 'ICAO item layout (Q/A/B/C/D/E/F/G), reconstructed from the published fields' },
]

export default function NotamViewControls({ showVfr = true }: { showVfr?: boolean }) {
  const { textView, setTextView, vfrOnly, setVfrOnly } = useNotamPrefs()
  return (
    <span className={css.row}>
      <span className={css.seg} role="group" aria-label="NOTAM text view">
        {VIEWS.map(({ v, label, title }) => (
          <button
            key={v}
            type="button"
            className={`${css.segBtn}${textView === v ? ` ${css.segBtnOn}` : ''}`}
            aria-pressed={textView === v}
            title={title}
            onClick={() => setTextView(v)}
          >{label}</button>
        ))}
      </span>
      {showVfr && (
        <button
          type="button"
          className={`${css.chip}${vfrOnly ? ` ${css.chipOn}` : ''}`}
          aria-pressed={vfrOnly}
          title={vfrOnly ? 'Showing VFR-relevant NOTAMs only — tap to include IFR-only ones' : 'Showing all NOTAMs, including IFR-only — tap to hide IFR-only'}
          onClick={() => setVfrOnly(!vfrOnly)}
        >VFR only</button>
      )}
    </span>
  )
}
