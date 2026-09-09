/**
 * LegActionMenu — small floating context menu shown when long-pressing a route
 * leg in planning mode or in-flight route adjustment mode.
 *
 * Actions:
 *  • "Insert here"    — insert a new WP at the pressed location
 *  • "Append to end"  — append the pressed location as the last waypoint
 *  • "Take Shortcut"  — skip ahead: remove all WPs between current active and
 *                        this point, then insert this point as the new next WP
 *  • "Cancel"
 */
import type { LngLat } from 'maplibre-gl'
import css from './WpActionMenu.module.css'

interface Props {
  lngLat:       LngLat
  /** Index of the leg (0-based) the user pressed on. */
  legIndex:     number
  /** Total number of waypoints in the route. */
  waypointCount: number
  /** Index of the active (next) waypoint during flight — used to show/hide
   *  "Take Shortcut". Pass -1 when in planning mode (shortcut not shown). */
  activeWpIdx:  number
  /** Pixel position on the map canvas. */
  x:            number
  y:            number
  /** Canvas dimensions, for clamping. */
  canvasW:      number
  canvasH:      number
  onInsert:    (lngLat: LngLat, legIndex: number) => void
  onAppend:    (lngLat: LngLat) => void
  /** Only called when a shortcut is valid (legIndex >= activeWpIdx). */
  onShortcut:  (lngLat: LngLat, legIndex: number) => void
  onClose:     () => void
}

export default function LegActionMenu({
  lngLat,
  legIndex,
  waypointCount,
  activeWpIdx,
  x,
  y,
  canvasW,
  canvasH,
  onInsert,
  onAppend,
  onShortcut,
  onClose,
}: Props) {
  const MENU_W = 172
  const MENU_H = 160
  const left = Math.min(x + 6, canvasW - MENU_W - 8)
  const top  = Math.min(y + 6, canvasH - MENU_H - 8)

  // "Take Shortcut" — skip all waypoints up to this leg's destination.
  // Only meaningful when flying and the pressed leg is ahead of the active WP.
  const canShortcut = activeWpIdx >= 0 && legIndex >= activeWpIdx

  // "Append" is not useful if the pressed leg is already on/near the last leg
  // (inserting after the last WP is equivalent to appending — keep it anyway).
  const isLastLeg = legIndex >= waypointCount - 2

  return (
    <>
      <div className={css.backdrop} onClick={onClose} />

      <div className={css.menu} style={{ left, top }}>
        <div className={css.header}>Route action</div>

        <button
          className={css.item}
          onClick={() => { onInsert(lngLat, legIndex); onClose() }}
        >
          + Insert here
        </button>

        {!isLastLeg && (
          <button
            className={css.item}
            onClick={() => { onAppend(lngLat); onClose() }}
          >
            ↓ Append to end
          </button>
        )}

        {canShortcut && (
          <button
            className={css.item}
            onClick={() => { onShortcut(lngLat, legIndex); onClose() }}
          >
            ✈ Take Shortcut
          </button>
        )}

        <button className={`${css.item} ${css.cancel}`} onClick={onClose}>
          Cancel
        </button>
      </div>
    </>
  )
}
