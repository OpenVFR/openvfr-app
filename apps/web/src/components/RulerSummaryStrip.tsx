import css from './RulerSummaryStrip.module.css'
import type { RouteWaypoint } from '../utils/routeCalc'
import { bearingDeg, distanceNm, magneticBearingDeg } from '../utils/routeCalc'
import type { Units } from '../utils/units'
import { nmToDisplay, distLabel } from '../utils/units'

interface Props {
  from: RouteWaypoint
  to: RouteWaypoint
  units: Units
  onClear: () => void
}

function fmtBrg(deg: number): string {
  return `${Math.round(deg).toString().padStart(3, '0')}°`
}

/**
 * Compact distance/track readout shown directly above the VirtualRadar
 * elevation profile while ruler mode is active. Exists because the full
 * RulerPanel lives buried in a SideDrawer section list — on-device, once
 * VirtualRadar mounts (same rulerMode + 2-point trigger), the drawer's
 * scroll position often leaves that readout off-screen, making it look
 * like the measurement info "disappeared" the moment the profile chart
 * shows up. This strip sits in the same place the user is already
 * looking (right above the chart) so it can't get scrolled out of view.
 */
export default function RulerSummaryStrip({ from, to, units, onClear }: Props) {
  const distNm      = distanceNm(from, to)
  const distDisplay = nmToDisplay(distNm, units.distance)
  const trueBrg     = bearingDeg(from, to)
  const magBrg      = magneticBearingDeg(from, to)

  return (
    <div className={css.strip}>
      <span className={css.item}>
        <span className={css.label}>DIST</span>
        <span className={css.value}>{distDisplay.toFixed(1)} {distLabel(units.distance)}</span>
      </span>
      <span className={css.item}>
        <span className={css.label}>TRUE</span>
        <span className={css.value}>{fmtBrg(trueBrg)}</span>
      </span>
      <span className={css.item}>
        <span className={css.label}>MAG</span>
        <span className={css.value}>{fmtBrg(magBrg)}</span>
      </span>
      <button className={css.clearBtn} onClick={onClear}>Clear</button>
    </div>
  )
}
