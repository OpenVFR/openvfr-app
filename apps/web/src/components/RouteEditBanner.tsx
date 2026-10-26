import css from './RouteEditBanner.module.css'

/**
 * Shown for the whole duration of a route edit session (first route change
 * in flight until Keep or Revert). Apply keeps the changes as an unsaved
 * working copy; Cancel restores the route as it was before the first change.
 */
export default function RouteEditBanner({
  label = 'Editing route', cancelLabel = 'Cancel', applyLabel = 'Apply',
  canUndo, canRedo, onUndo, onRedo, onCancel, onApply,
}: {
  label?: string
  cancelLabel?: string
  applyLabel?: string
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onCancel: () => void
  onApply: () => void
}) {
  return (
    <div className={css.banner} role="group" aria-label="Route edit session" data-testid="route-edit-banner">
      <span className={css.label}>{label}</span>
      <button type="button" className={css.iconBtn} onClick={onUndo} disabled={!canUndo} title="Undo" aria-label="Undo">↶</button>
      <button type="button" className={css.iconBtn} onClick={onRedo} disabled={!canRedo} title="Redo" aria-label="Redo">↷</button>
      <button type="button" className={css.cancelBtn} onClick={onCancel} title="Restore the route as it was before these changes">{cancelLabel}</button>
      <button type="button" className={css.applyBtn} onClick={onApply} title="Keep the changes (not saved to the library)">{applyLabel}</button>
    </div>
  )
}
