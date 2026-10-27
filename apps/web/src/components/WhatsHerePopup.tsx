import { useState } from 'react'
import type { AerodromeFeatureProps } from './AerodromePopup'
import type { NavaidFeature, WaypointFeature, ObstacleFeature, LandmarkFeature } from './FeaturePopup'
import type { AirspaceFeature } from './AirspacePopup'
import type { RouteWaypoint } from '../utils/routeCalc'
import css from './WhatsHerePopup.module.css'

// ── Item type union ───────────────────────────────────────────────────────────

export type WhatsHereItem =
  | { kind: 'aerodrome';    props: AerodromeFeatureProps; lng: number; lat: number }
  | { kind: 'navaid';       feature: NavaidFeature;        lng: number; lat: number }
  | { kind: 'waypoint';     feature: WaypointFeature;      lng: number; lat: number }
  | { kind: 'obstacle';     feature: ObstacleFeature }
  | { kind: 'landmark';     feature: LandmarkFeature }
  | { kind: 'userWaypoint'; id: string; name: string; folder: string; lng: number; lat: number }

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a RouteWaypoint if the item is a valid route turning point. */
export function whatsHereRouteWaypoint(item: WhatsHereItem): RouteWaypoint | null {
  switch (item.kind) {
    case 'aerodrome':    return { lng: item.lng, lat: item.lat, name: item.props.icao }
    case 'navaid':       return { lng: item.lng, lat: item.lat, name: item.feature.id }
    case 'waypoint':     return { lng: item.lng, lat: item.lat, name: item.feature.id }
    case 'userWaypoint': return { lng: item.lng, lat: item.lat, name: item.name }
    default:             return null
  }
}

const KIND_BADGE: Record<WhatsHereItem['kind'], string> = {
  aerodrome:    'AD',
  navaid:       'NAV',
  waypoint:     'WP',
  obstacle:     'OBS',
  landmark:     'LMK',
  userWaypoint: 'UWP',
}

function itemLabel(item: WhatsHereItem): string {
  switch (item.kind) {
    case 'aerodrome':
      return `${item.props.icao} — ${item.props.name}`
    case 'navaid':
      return `${item.feature.id} — ${item.feature.navaid_type} ${item.feature.freq_str}`
    case 'waypoint':
      return item.feature.name
        ? `${item.feature.id} — ${item.feature.name}`
        : item.feature.id
    case 'obstacle':
      return item.feature.name || item.feature.obstacleKind
    case 'landmark':
      return item.feature.name || item.feature.landmarkKind
    case 'userWaypoint':
      return item.folder ? `${item.name} (${item.folder})` : item.name
  }
}

/** Format a coordinate as degrees + decimal minutes, e.g. "59°19.758N". */
function dmmStr(v: number, isLat: boolean): string {
  const abs = Math.abs(v)
  const deg = Math.floor(abs)
  const min = ((abs - deg) * 60).toFixed(3)
  const dir = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W')
  return `${deg}°${min}${dir}`
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  items: WhatsHereItem[]
  airspaceFeatures: AirspaceFeature[]
  lng: number
  lat: number
  onSaveUserWaypoint: (name: string, lng: number, lat: number) => void
  onClose: () => void
  /** The route action for a point (each row, and the clicked position
   *  itself): start / add on the ground, Direct to / Take shortcut in flight.
   *  `rejoin`: an en-route fix (rejoin the route after it) rather than a destination. */
  routeActionFor: (wp: RouteWaypoint, rejoin: boolean) => RouteAction
  /** In flight only: rows also offer Track. */
  onTrack?: (wp: RouteWaypoint, kind: 'aerodrome' | 'navaid' | 'waypoint') => void
}

/** A point's route button. `kind` 'route' = add to / start the route (ground),
 *  'direct' = fly there now (flight). */
export interface RouteAction {
  kind: 'route' | 'direct'
  label: string
  onClick: () => void
}

export default function WhatsHerePopup({
  items, airspaceFeatures, lng, lat,
  routeActionFor, onTrack, onSaveUserWaypoint, onClose,
}: Props) {
  const pointAction = routeActionFor({ lng, lat }, true)
  const [airspaceOpen, setAirspaceOpen] = useState(true)
  const [saveName, setSaveName] = useState<string | null>(null)
  // Opened on a feature itself (a place, say): its own row already has the
  // route button, so no second one for "this point".
  const pointIsItem = items.some((i) => 'lng' in i && i.lng === lng && i.lat === lat)

  return (
    <div className={css.panel}>
      {/* Header */}
      <div className={css.header}>
        <span className={css.title}>What's Here?</span>
        <span className={css.coords}>{dmmStr(lat, true)} {dmmStr(lng, false)}</span>
        <button className={css.close} onClick={onClose} aria-label="Close">✕</button>
      </div>

      {/* Point features */}
      {items.length > 0 && (
        <ul className={css.list}>
          {items.map((item, i) => {
            const wp = whatsHereRouteWaypoint(item)
            const action = wp ? routeActionFor(wp, item.kind !== 'aerodrome') : null
            return (
              <li key={i} className={css.row}>
                <span className={`${css.badge} ${css[`kind_${item.kind}`]}`}>
                  {KIND_BADGE[item.kind]}
                </span>
                <span className={css.rowLabel}>{itemLabel(item)}</span>
                {wp && action && (
                  <button
                    className={css.addBtn}
                    onClick={() => { action.onClick(); onClose() }}
                    title={action.kind === 'direct' ? 'Fly there from your present position (legs already flown stay in the route)' : action.label}
                    aria-label={action.label}
                  >
                    {action.kind === 'direct' ? action.label : '+Route'}
                  </button>
                )}
                {wp && onTrack && (
                  <button
                    className={css.addBtn}
                    onClick={() => { onTrack(wp, item.kind === 'aerodrome' || item.kind === 'navaid' ? item.kind : 'waypoint'); onClose() }}
                    title="Show distance and bearing to this point in the position report (the route is unchanged)"
                  >
                    Track
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* Airspace (collapsible) */}
      {airspaceFeatures.length > 0 && (
        <div className={css.airspace}>
          <button className={css.airspaceToggle} onClick={() => setAirspaceOpen(o => !o)}>
            <span>Airspace ({airspaceFeatures.length})</span>
            <span className={css.chevron}>{airspaceOpen ? '▾' : '▸'}</span>
          </button>
          {airspaceOpen && (
            <ul className={css.airspaceList}>
              {airspaceFeatures.map((a, i) => (
                <li key={i} className={css.airspaceRow}>
                  <span
                    className={`${css.classTag} ${css[`cls_${a.class}`] ?? ''}`}
                  >
                    {a.class}
                  </span>
                  <span className={css.airspaceName}>{a.name}</span>
                  <span className={css.airspaceAlt}>{a.lower} – {a.upper}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Empty notice */}
      {items.length === 0 && airspaceFeatures.length === 0 && (
        <div className={css.empty}>No aviation features at this location.</div>
      )}

      {/* Save as user waypoint */}
      {saveName === null ? (
        <div className={css.footer}>
          {!pointIsItem && (
            <button className={css.saveBtn} onClick={() => { pointAction.onClick(); onClose() }}>
              {pointAction.kind === 'route' ? '+ ' : '\u2708 '}{pointAction.label} (this point)
            </button>
          )}
          <button className={css.saveBtn} onClick={() => setSaveName('')}>
            📍 Save Place
          </button>
        </div>
      ) : (
        <div className={css.saveForm}>
          <input
            className={css.saveInput}
            value={saveName}
            onChange={e => setSaveName(e.target.value)}
            placeholder="Place name (optional)…"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter') {
                onSaveUserWaypoint(saveName.trim(), lng, lat)
                setSaveName(null)
                onClose()
              } else if (e.key === 'Escape') {
                setSaveName(null)
              }
            }}
          />
          <button
            className={css.saveConfirm}
            onClick={() => {
              onSaveUserWaypoint(saveName.trim(), lng, lat)
              setSaveName(null)
              onClose()
            }}
          >
            Save
          </button>
          <button className={css.saveCancel} onClick={() => setSaveName(null)}>✕</button>
        </div>
      )}
    </div>
  )
}
