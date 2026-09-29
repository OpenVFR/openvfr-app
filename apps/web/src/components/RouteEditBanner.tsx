import css from './RouteEditBanner.module.css'

/**
 * Shown for the whole duration of a route edit session (first edit in
 * planning/adjust mode until Apply or Cancel). Apply keeps the changes as an
 * unsaved working copy; Cancel restores the route as it was before the first
 * edit.
 */
export default function RouteEditBanner({
  canUndo, canRedo, onUndo, onRedo, onCancel, onApply,
}: {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onCancel: () => void
  onApply: () => void
}) {
  return (
    <div className={css.banner} role="group" aria-label="Route edit session" data-testid="route-edit-banner">
      <span className={css.label}>Editing route</span>
      <button type="button" className={css.iconBtn} onClick={onUndo} disabled={!canUndo} title="Undo" aria-label="Undo">↶</button>
      <button type="button" className={css.iconBtn} onClick={onRedo} disabled={!canRedo} title="Redo" aria-label="Redo">↷</button>
      <button type="button" className={css.cancelBtn} onClick={onCancel} title="Discard all changes made in this session">Cancel</button>
      <button type="button" className={css.applyBtn} onClick={onApply} title="Keep the changes (not saved to the library)">Apply</button>
    </div>
  )
}
