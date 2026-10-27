import { memo, useEffect, useRef } from 'react'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import type { RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import AerodromePopup, { type AerodromeFeatureProps } from './AerodromePopup'
import AirspacePopup, { type AirspaceFeature, type RegionalNotamHit } from './AirspacePopup'
import FeaturePopup, { type PointFeature } from './FeaturePopup'
import WhatsHerePopup, { type WhatsHereItem, type RouteAction } from './WhatsHerePopup'
import type { RouteWaypoint } from '../utils/routeCalc'
import css from './FeatureCard.module.css'

/** What was clicked on the map (or found via What's Here?). */
export type ActiveInfo =
  | { kind: 'aerodrome'; props: AerodromeFeatureProps; lng: number; lat: number }
  | { kind: 'airspace';  features: AirspaceFeature[]; regionalNotams?: RegionalNotamHit[]; focusKey?: string }
  | { kind: 'point';     feature: PointFeature; routeWp?: RouteWaypoint }
  | { kind: 'whatshere'; items: WhatsHereItem[]; airspaceFeatures: AirspaceFeature[]; lng: number; lat: number }

interface Props {
  info: ActiveInfo
  onClose: () => void
  isHome: (icao: string) => boolean
  /** Signed in: weather / NOTAM fetches need auth. */
  authed: boolean
  onSetHome: (icao: string, name: string, lng: number, lat: number) => void
  onRunwayWind?: (icao: string, ends: RunwayWindEnd[]) => void
  regionalNotams?: NotamItem[]
  routeWaypoints: RouteWaypoint[]
  onShowNotamOnMap?: (notam: NotamItem) => void
  /** The one route action for a point, used by every card kind: start / add
   *  on the ground, Direct to / Take shortcut in flight.
   *  `rejoin`: an en-route fix rather than a destination. */
  routeActionFor: (wp: RouteWaypoint, rejoin: boolean) => RouteAction
  onSaveHereUserWaypoint: (name: string, lng: number, lat: number) => void
  /** In flight only (undefined on the ground): What's Here? rows add Track. */
  onTrackPoint?: (wp: RouteWaypoint, kind: 'aerodrome' | 'navaid' | 'waypoint') => void
  /** Not read: changes re-render the memoised card so route button labels
   *  ("Start route here" / "Add to route" / "Take shortcut") stay current. */
  routeKey?: string
  /** Not read: the home airfield, so the card's "Home" button re-renders
   *  when it changes (isHome is a stable wrapper). */
  homeIcao?: string | null
}

/**
 * Info about the clicked map feature, as a card beside the map: docked to
 * the map's right edge on desktop, a bottom sheet on narrow screens. Not
 * modal -- the map stays live, so another click switches the card and route
 * planning goes on while it is open; the side pane (plan and libraries)
 * never moves. Closed with its own close button or Esc.
 */
function FeatureCard({
  info, onClose, isHome, authed, onSetHome, onRunwayWind, regionalNotams, routeWaypoints,
  onShowNotamOnMap, routeActionFor, onSaveHereUserWaypoint, onTrackPoint,
}: Props) {
  // Keyboard / screen reader: the card takes focus when it opens from the
  // map (so it is found), and gives it back when it closes. Not when opened
  // while typing somewhere (search): focus stays in that field.
  const cardRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const typing = !!before && (before.tagName === 'INPUT' || before.tagName === 'TEXTAREA' || before.isContentEditable)
    if (!typing) cardRef.current?.focus({ preventScroll: true })
    return () => {
      // Closed with focus in the card (now gone: focus fell to <body>).
      const lost = !document.activeElement || document.activeElement === document.body
      if (!typing && lost && before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [])
  return (
    <aside ref={cardRef} tabIndex={-1} className={css.card} aria-label="Selected map feature" data-feature-card="">
      <div className={css.scroll}>
        {info.kind === 'aerodrome' && (
          <AerodromePopup
            key={info.props.icao}
            props={info.props}
            lng={info.lng}
            lat={info.lat}
            isHome={isHome(info.props.icao)}
            authed={authed}
            onSetHome={onSetHome}
            onClose={onClose}
            onRunwayWind={onRunwayWind}
            regionalNotams={regionalNotams}
            routeWaypoints={routeWaypoints}
            onShowNotamOnMap={onShowNotamOnMap}
            routeAction={routeActionFor({ lng: info.lng, lat: info.lat, name: info.props.icao }, false)}
          />
        )}
        {info.kind === 'airspace' && (
          <AirspacePopup
            features={info.features}
            regionalNotams={info.regionalNotams}
            focusKey={info.focusKey}
            onClose={onClose}
          />
        )}
        {info.kind === 'point' && (
          <FeaturePopup
            feature={info.feature}
            onClose={onClose}
            routeAction={info.routeWp ? routeActionFor(info.routeWp, true) : undefined}
          />
        )}
        {info.kind === 'whatshere' && (
          <WhatsHerePopup
            items={info.items}
            airspaceFeatures={info.airspaceFeatures}
            lng={info.lng}
            lat={info.lat}
            routeActionFor={routeActionFor}
            onTrack={onTrackPoint}
            onSaveUserWaypoint={onSaveHereUserWaypoint}
            onClose={onClose}
          />
        )}
      </div>
    </aside>
  )
}

export default memo(FeatureCard)
