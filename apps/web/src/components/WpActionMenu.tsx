/**
 * WpActionMenu — small floating context menu shown when tapping a route
 * waypoint in in-flight route adjustment mode.
 *
 * Actions:
 *  • "Direct to [WP]" — take a shortcut, cutting all waypoints before this one
 *  • "Remove waypoint"
 *  • "Cancel"
 */
import type { RouteWaypoint } from '../utils/routeCalc'
import css from './WpActionMenu.module.css'

interface Props {
  wpIdx:          number
  waypoints:      RouteWaypoint[]
  /** Index of the next target waypoint (active leg start). */
  activeWpIdx:    number
  /** Pixel position on the map canvas where the tap occurred. */
  x:              number
  y:              number
  /** Total map canvas dimensions, for clamping the menu inside the viewport. */
  canvasW:        number
  canvasH:        number
  onDirectTo:     (idx: number) => void
  onRemove:       (idx: number) => void
  onClose:        () => void
}

export default function WpActionMenu({
  wpIdx,
  waypoints,
  activeWpIdx,
  x,
  y,
  canvasW,
  canvasH,
  onDirectTo,
  onRemove,
  onClose,
}: Props) {
  const wp = waypoints[wpIdx]
  const label = wp?.name ?? `WP ${wpIdx + 1}`

  // Clamp position so the menu doesn't overflow the canvas edge.
  // Menu is ~160 px wide and ~120 px tall (approx).
  const MENU_W = 164
  const MENU_H = 120
  const left = Math.min(x + 6, canvasW - MENU_W - 8)
  const top  = Math.min(y + 6, canvasH - MENU_H - 8)

  // "Direct to" only makes sense for waypoints ahead of the current active one
  const canDirectTo = wpIdx > activeWpIdx

  return (
    <>
      {/* Click-away backdrop */}
      <div className={css.backdrop} onClick={onClose} />

      <div className={css.menu} style={{ left, top }}>
        <div className={css.header}>{label}</div>

        {canDirectTo && (
          <button
            className={css.item}
            onClick={() => { onDirectTo(wpIdx); onClose() }}
          >
            ✈ Direct To
          </button>
        )}

        <button
          className={css.item}
          onClick={() => { onRemove(wpIdx); onClose() }}
        >
          ✕ Remove
        </button>

        <button className={`${css.item} ${css.cancel}`} onClick={onClose}>
          Cancel
        </button>
      </div>
    </>
  )
}
