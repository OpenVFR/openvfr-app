/** The "Hide this NOTAM" button and the "N hidden by you" note shared by the NOTAM lists (see useTriagedList). */
import ctlCss from './NotamViewControls.module.css'

export function HideNotamButton({ hidden, onClick }: { hidden: boolean; onClick: () => void }) {
  return <button className={ctlCss.hideBtn} onClick={onClick}>{hidden ? 'Unhide' : 'Hide this NOTAM'}</button>
}

export function HiddenNotamsNote({ count, shown, onToggle }: { count: number; shown: boolean; onToggle: () => void }) {
  if (count === 0) return null
  return (
    <div className={ctlCss.hiddenNote}>
      {count} hidden by you
      <button onClick={onToggle}>{shown ? 'Fold away' : 'Show'}</button>
    </div>
  )
}
