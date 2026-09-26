import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import LayerPanel from './LayerPanel'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import AltitudeSlider from './AltitudeSlider'
import SettingsPanel from './SettingsPanel'
import RoutePlan from './RoutePlan'
import PreflightWarnings from './PreflightWarnings'
import RouteLibrary from './RouteLibrary'
import AircraftLibrary from './AircraftLibrary'
import FuelPlan from './FuelPlan'
import FindFeature, { type FindResult } from './FindFeature'
import AccountBadge from './AccountBadge'
import type { AuthState } from '../hooks/useAuth'
import AerodromePopup, { type AerodromeFeatureProps } from './AerodromePopup'
import type { RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import AirspacePopup, { type AirspaceFeature, type RegionalNotamHit } from './AirspacePopup'
import FeaturePopup, { type PointFeature } from './FeaturePopup'
import WhatsHerePopup, { type WhatsHereItem } from './WhatsHerePopup'
import RulerPanel from './RulerPanel'
import UserWaypoints from './UserWaypoints'
import FlightLogs from './FlightLogs'
import type { Units } from '../utils/units'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride, AircraftProfileDocType, UserWaypointDocType } from '../db/index'
import type { Theme, TrajectoryMode, AirspaceWarnLookahead, TerrainColoringSettings, TrafficVertFilter, ParkTimeoutOption } from '../db/useSettings'
import type { DataManifest } from '../hooks/useDataManifest'
import css from './SideDrawer.module.css'

export type ActiveInfo =
  | { kind: 'aerodrome'; props: AerodromeFeatureProps; lng: number; lat: number }
  | { kind: 'airspace';  features: AirspaceFeature[]; regionalNotams?: RegionalNotamHit[] }
  | { kind: 'point';     feature: PointFeature }
  | { kind: 'whatshere'; items: WhatsHereItem[]; airspaceFeatures: AirspaceFeature[]; lng: number; lat: number }
  | null

interface Props {
  // Map controls
  visibility: Record<string, boolean>
  onVisibilityChange: (groupId: string, on: boolean) => void
  ceilingFt: number
  onCeilingChange: (ft: number) => void
  units: Units
  onUnitsChange: (u: Units) => void
  region: string
  onRegionChange: (code: string) => void
  theme: Theme
  onThemeChange: (t: Theme) => void
  autoZoom: boolean
  onAutoZoomChange: (v: boolean) => void
  trajectoryMode: TrajectoryMode
  onTrajectoryModeChange: (v: TrajectoryMode) => void
  airspaceWarnLookahead: AirspaceWarnLookahead
  onAirspaceWarnLookaheadChange: (v: AirspaceWarnLookahead) => void
  airspaceWarnVerticalFt: number
  onAirspaceWarnVerticalFtChange: (v: number) => void
  terrainColoring: TerrainColoringSettings
  onTerrainColoringChange: (v: TerrainColoringSettings) => void
  trafficVertFilter: TrafficVertFilter
  onTrafficVertFilterChange: (v: TrafficVertFilter) => void
  parkTimeout: ParkTimeoutOption
  onParkTimeoutChange: (v: ParkTimeoutOption) => void
  /** True when aircraft is airborne (GS ≥ 30 kts); locks data-load controls. */
  inFlight?: boolean
  manifest?: DataManifest | null
  isOnline?: boolean
  checking?: boolean
  onRefresh?: () => void
  // Route plan
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  /** Route activate/deactivate -- shows/hides the drawn route on the map without clearing its waypoints, mirrors native's PlanScreen Active/Inactive toggle. */
  routeVisible: boolean
  onToggleRouteVisible: () => void
  planningMode: boolean
  onTogglePlanningMode: () => void
  onUndo: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
  onClear: () => void
  onReplace: (wps: RouteWaypoint[]) => void
  onLoadRoute: (wps: RouteWaypoint[], legOverrides: LegOverride[], aircraftId: string) => void
  /** Id of the saved route the working route was loaded from, or '' if untitled. */
  activeRouteId: string
  onActiveRouteIdChange: (id: string) => void
  onSetLegOverride: (idx: number, override: LegOverride) => void
  onSetWaypointNote: (wpIdx: number, note: string) => void
  // Add to route (used by WhatsHere + UserWaypoints)
  onAddToRoute: (wp: RouteWaypoint) => void
  // Aircraft selection
  selectedAircraftId?: string
  selectedAircraftProfile?: AircraftProfileDocType
  onSelectAircraft?: (id: string | null) => void
  // Search / fly-to
  onFlyTo: (r: FindResult) => void
  // Feature info panel
  activeInfo: ActiveInfo
  onCloseInfo: () => void
  isHome: (icao: string) => boolean
  onSetHome: (icao: string, name: string, lng: number, lat: number) => void
  /** Forwarded to AerodromePopup so the map's runway threshold labels can mirror its favored-end highlight. */
  onRunwayWind?: (icao: string, ends: RunwayWindEnd[]) => void
  // FIR-wide regional NOTAMs (unfiltered), forwarded to AerodromePopup's own
  // "Other NOTAMs" section (see that component's regionalNotams Props doc
  // comment) when activeInfo.kind === 'aerodrome' -- filtering to the
  // planned route (waypoints, above) happens inside AerodromePopup itself.
  regionalNotams?: NotamItem[]
  onShowNotamOnMap?: (notam: NotamItem) => void
  // Map ruler
  rulerActive: boolean
  rulerPoints: RouteWaypoint[]
  onClearRuler: () => void
  // Flight logs
  selectedLogId: string | null
  onSelectLog: (id: string) => void
  onClearLog: () => void
  // User waypoints
  userWaypoints: UserWaypointDocType[]
  pendingUserWpCoords: { lng: number; lat: number } | null
  folderVisibility: Record<string, boolean>
  onUserWpCoordsConsumed: () => void
  onStartPlaceUserWp: () => void
  onSaveUserWaypoint: (wp: Omit<UserWaypointDocType, 'id' | 'updatedAt'>) => void
  onDeleteUserWaypoint: (id: string) => void
  onRenameUserWaypoint: (id: string, name: string) => void
  onMoveUserWpFolder: (id: string, folder: string) => void
  onFolderVisChange: (folder: string, visible: boolean) => void
  onSaveHereUserWaypoint: (name: string, lng: number, lat: number) => void
  auth: AuthState
  onOpenProfile: () => void
}

const SECTION_LABELS = {
  info:          'Selected Feature',
  route:         'Route Plan',
  preflight:     'Pre-flight Check',
  fuel:          'Fuel Plan',
  ruler:         'Map Ruler',
  routes:        'Routes',
  flightLogs:    'Flight Logs',
  aircraft:      'Aircraft',
  userWaypoints: 'User Waypoints',
  layers:        'Layers',
  altitude:      'Altitude Filter',
  settings:      'Settings',
} as const

type Section = keyof typeof SECTION_LABELS

const MIN_WIDTH = 220
const MAX_WIDTH = 520
const DEFAULT_WIDTH = 272

const LS_OPEN     = 'ovfr:drawer:open'
const LS_WIDTH    = 'ovfr:drawer:width'
const LS_EXPANDED = 'ovfr:drawer:expanded'

function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v !== null ? (JSON.parse(v) as T) : fallback
  } catch { return fallback }
}
function lsSet(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota */ }
}

export default function SideDrawer({
  visibility, onVisibilityChange,
  ceilingFt, onCeilingChange,
  units, onUnitsChange,
  region, onRegionChange,
  theme, onThemeChange,
  autoZoom, onAutoZoomChange,
  trajectoryMode, onTrajectoryModeChange,
  airspaceWarnLookahead, onAirspaceWarnLookaheadChange,
  airspaceWarnVerticalFt, onAirspaceWarnVerticalFtChange,
  terrainColoring, onTerrainColoringChange,
  trafficVertFilter, onTrafficVertFilterChange,
  parkTimeout, onParkTimeoutChange,
  inFlight,
  manifest,
  isOnline,
  checking,
  onRefresh,
  waypoints, legOverrides, routeVisible, onToggleRouteVisible, planningMode, onTogglePlanningMode,
  onUndo, onRedo, canUndo, canRedo, onClear, onReplace, onLoadRoute, activeRouteId, onActiveRouteIdChange, onSetLegOverride, onSetWaypointNote,
  onAddToRoute,
  selectedAircraftId, selectedAircraftProfile, onSelectAircraft,
  onFlyTo,
  activeInfo, onCloseInfo,
  isHome, onSetHome, onRunwayWind, regionalNotams, onShowNotamOnMap,
  rulerActive, rulerPoints, onClearRuler,
  selectedLogId, onSelectLog, onClearLog,
  userWaypoints, pendingUserWpCoords, folderVisibility,
  onUserWpCoordsConsumed, onStartPlaceUserWp,
  onSaveUserWaypoint, onDeleteUserWaypoint, onRenameUserWaypoint, onMoveUserWpFolder,
  onFolderVisChange, onSaveHereUserWaypoint,
  auth,
  onOpenProfile,
}: Props) {
  const [open, setOpen]         = useState(() => lsGet(LS_OPEN, false))
  const [width, setWidth]       = useState(() => lsGet(LS_WIDTH, DEFAULT_WIDTH))
  const [expanded, setExpanded] = useState<Record<Section, boolean>>(() =>
    lsGet(LS_EXPANDED, { info: true, route: true, preflight: true, fuel: true, ruler: true, routes: true, flightLogs: true, aircraft: false, userWaypoints: true, layers: true, altitude: true, settings: false })
  )

  // Drag-resize handle
  const dragging = useRef(false)
  const startX   = useRef(0)
  const startW   = useRef(0)

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current   = e.clientX
    startW.current   = width
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = ev.clientX - startX.current
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW.current + delta)))
    }
    const onUp = () => {
      dragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [width])

  // Auto-open the drawer when a feature is tapped, route exists, ruler is set, or user WP coords arrive.
  useEffect(() => {
    if (activeInfo) { setOpen(true) }
  }, [activeInfo])

  useEffect(() => {
    if (waypoints.length > 0) { setOpen(true) }
  }, [waypoints.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (rulerActive && rulerPoints.length === 2) {
      setOpen(true)
      setExpanded(e => ({ ...e, ruler: true }))
    }
  }, [rulerActive, rulerPoints.length]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pendingUserWpCoords) {
      setOpen(true)
      setExpanded(e => ({ ...e, userWaypoints: true }))
    }
  }, [pendingUserWpCoords])

  // Persist state to localStorage whenever it changes.
  useEffect(() => { lsSet(LS_OPEN, open) }, [open])
  useEffect(() => { lsSet(LS_WIDTH, width) }, [width])
  useEffect(() => { lsSet(LS_EXPANDED, expanded) }, [expanded])

  // Apply drawer width to the --drawer-width CSS var; the open/close is
  // handled by the drawerClosed CSS class (translateX transform on .drawer).
  const wrapperRef = useRef<HTMLDivElement>(null)
  // On touch (pointer: coarse) the drawer is position:fixed and overlays the
  // map — the grid column stays zero so the map always fills the full width.
  const isTouch = useRef(
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
  )
  useLayoutEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    el.style.setProperty('--drawer-width', `${width}px`)
    // Push the map area right when open by widening the grid column.
    // Skip on touch: drawer overlays the map as a fixed panel.
    if (!isTouch.current) {
      el.style.width = open ? `${width}px` : '0'
    }
  })

  const toggle = (s: Section) => setExpanded(p => ({ ...p, [s]: !p[s] }))

  const hasRoute = waypoints.length > 0
  // Computed once here (not inline in JSX) so the section header's count
  // badge and the panel body agree -- both must reflect the SAME filtered
  // list, not the badge showing the unfiltered total while the body below
  // shows a route-filtered subset.

  return (
    <div ref={wrapperRef} className={css.wrapper}>
      {/* Backdrop: tap the map area to close the drawer on touch devices. */}
      {open && (
        <div className={css.backdrop} onClick={() => setOpen(false)} aria-hidden="true" />
      )}
      <div className={`${css.drawer} ${open ? '' : css.drawerClosed}`}>
        <div className={css.searchBar}>
          <FindFeature onResult={onFlyTo} onAddToRoute={onAddToRoute} />
        </div>
        <div className={css.scroll}>

          {/* ── Selected Feature ───────────────────────────────── */}
          {activeInfo && (
            <div className={css.section}>
              <button className={css.sectionHeader} onClick={() => toggle('info')}>
                <span>{SECTION_LABELS.info}</span>
                <span className={css.chevron}>{expanded.info ? '▾' : '▸'}</span>
              </button>
              {expanded.info && (
                <div className={css.sectionBody}>
                  {activeInfo.kind === 'aerodrome' && (
                    <AerodromePopup
                      key={activeInfo.props.icao}
                      props={activeInfo.props}
                      lng={activeInfo.lng}
                      lat={activeInfo.lat}
                      isHome={isHome(activeInfo.props.icao)}
                      authed={!!auth.user}
                      onSetHome={onSetHome}
                      onClose={onCloseInfo}
                      onRunwayWind={onRunwayWind}
                      regionalNotams={regionalNotams}
                      routeWaypoints={waypoints}
                      onShowNotamOnMap={onShowNotamOnMap}
                    />
                  )}
                  {activeInfo.kind === 'airspace' && (
                    <AirspacePopup
                      features={activeInfo.features}
                      regionalNotams={activeInfo.regionalNotams}
                      onClose={onCloseInfo}
                    />
                  )}
                  {activeInfo.kind === 'point' && (
                    <FeaturePopup
                      feature={activeInfo.feature}
                      onClose={onCloseInfo}
                    />
                  )}
                  {activeInfo.kind === 'whatshere' && (
                    <WhatsHerePopup
                      items={activeInfo.items}
                      airspaceFeatures={activeInfo.airspaceFeatures}
                      lng={activeInfo.lng}
                      lat={activeInfo.lat}
                      onAddToRoute={onAddToRoute}
                      onSaveUserWaypoint={onSaveHereUserWaypoint}
                      onClose={onCloseInfo}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Route Plan ─────────────────────────────────────── */}
          <div className={css.section}>
            <button className={css.sectionHeader} onClick={() => toggle('route')}>
              <span>{SECTION_LABELS.route}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  role="button"
                  className={`${css.planPill} ${planningMode ? css.planPillActive : ''}`}
                  onClick={(e) => { e.stopPropagation(); onTogglePlanningMode() }}
                >
                  {planningMode ? 'Editing' : 'Locked'}
                </span>
                <span className={css.chevron}>{expanded.route ? '▾' : '▸'}</span>
              </span>
            </button>
            {expanded.route && hasRoute && (
              <div className={css.sectionBody}>
                  <RoutePlan
                    waypoints={waypoints}
                    legOverrides={legOverrides}
                    routeVisible={routeVisible}
                    onToggleRouteVisible={onToggleRouteVisible}
                    units={units}
                    onUndo={onUndo}
                    onRedo={onRedo}
                    canUndo={canUndo}
                    canRedo={canRedo}
                    onClear={onClear}
                    onReplace={onReplace}
                    onAddToRoute={onAddToRoute}
                    onSetLegOverride={onSetLegOverride}
                    onSetWaypointNote={onSetWaypointNote}
                  />
              </div>
            )}
            {expanded.route && !hasRoute && (
              <div className={css.sectionBody}>
                <p style={{ padding: '4px 12px', color: 'var(--text-muted)', fontSize: 11 }}>
                  No route yet. Tap "Locked" above to start planning, then click the map to add waypoints.
                </p>
                {canUndo && (
                  <button style={{ margin: '0 12px 6px', fontSize: 11 }} onClick={onUndo} title="Undo last route change (Ctrl+Z)">↶ Undo</button>
                )}
              </div>
            )}
          </div>

          {/* ── Pre-flight Check ───────────────────────────────── */}
          {hasRoute && waypoints.length >= 2 && (
            <div className={css.section}>
              <button className={css.sectionHeader} onClick={() => toggle('preflight')}>
                <span>{SECTION_LABELS.preflight}</span>
                <span className={css.chevron}>{expanded.preflight ? '▾' : '▸'}</span>
              </button>
              {expanded.preflight && (
                <div className={css.sectionBody}>
                  <PreflightWarnings
                    waypoints={waypoints}
                    legOverrides={legOverrides}
                    aircraft={selectedAircraftProfile}
                    aircraftId={selectedAircraftId}
                  />
                </div>
              )}
            </div>
          )}

          {/* ── Fuel Plan ──────────────────────────────────────── */}
          {hasRoute && selectedAircraftProfile && (
            <div className={css.section}>
              <button className={css.sectionHeader} onClick={() => toggle('fuel')}>
                <span>{SECTION_LABELS.fuel}</span>
                <span className={css.chevron}>{expanded.fuel ? '▾' : '▸'}</span>
              </button>
              {expanded.fuel && (
                <div className={css.sectionBody}>
                  <FuelPlan
                    waypoints={waypoints}
                    legOverrides={legOverrides}
                    aircraft={selectedAircraftProfile}
                  />
                </div>
              )}
            </div>
          )}

          {/* ── Map Ruler ──────────────────────────────────────── */}
          {rulerActive && rulerPoints.length === 2 && (
            <div className={css.section}>
              <button className={css.sectionHeader} onClick={() => toggle('ruler')}>
                <span>{SECTION_LABELS.ruler}</span>
                <span className={css.chevron}>{expanded.ruler ? '▾' : '▸'}</span>
              </button>
              {expanded.ruler && (
                <div className={css.sectionBody}>
                  <RulerPanel
                    from={rulerPoints[0]}
                    to={rulerPoints[1]}
                    units={units}
                    aircraftProfile={selectedAircraftProfile}
                    onClear={onClearRuler}
                  />
                </div>
              )}
            </div>
          )}

          {/* ── Routes (library) ───────────────────────────────── */}
          <div className={css.section}>
            <button className={css.sectionHeader} onClick={() => toggle('routes')}>
              <span>{SECTION_LABELS.routes}</span>
              <span className={css.chevron}>{expanded.routes ? '▾' : '▸'}</span>
            </button>
            {expanded.routes && (
              <div className={css.sectionBody}>
                <RouteLibrary
                  currentWaypoints={waypoints}
                  currentLegOverrides={legOverrides}
                  currentAircraftId={selectedAircraftId ?? ''}
                  onLoad={onLoadRoute}
                  onClear={onClear}
                  activeRouteId={activeRouteId}
                  onActiveRouteIdChange={onActiveRouteIdChange}
                />
              </div>
            )}
          </div>

          {/* ── Flight Logs ────────────────────────────────────── */}
          <div className={css.section}>
            <button className={css.sectionHeader} onClick={() => toggle('flightLogs')}>
              <span>{SECTION_LABELS.flightLogs}</span>
              <span className={css.chevron}>{expanded.flightLogs ? '▾' : '▸'}</span>
            </button>
            {expanded.flightLogs && (
              <div className={css.sectionBody}>
                <FlightLogs
                  selectedLogId={selectedLogId}
                  onSelect={onSelectLog}
                  onClear={onClearLog}
                />
              </div>
            )}
          </div>

          {/* ── Aircraft ───────────────────────────────────────── */}
          <div className={css.section}>
            <button className={css.sectionHeader} onClick={() => toggle('aircraft')}>
              <span>{SECTION_LABELS.aircraft}</span>
              <span className={css.chevron}>{expanded.aircraft ? '▾' : '▸'}</span>
            </button>
            {expanded.aircraft && (
              <div className={css.sectionBody}>
                <AircraftLibrary selectedId={selectedAircraftId} onSelect={onSelectAircraft} />
              </div>
            )}
          </div>

          {/* ── User Waypoints ─────────────────────────────────── */}
          <div className={css.section}>
            <button className={css.sectionHeader} onClick={() => toggle('userWaypoints')}>
              <span>{SECTION_LABELS.userWaypoints}</span>
              <span className={css.chevron}>{expanded.userWaypoints ? '▾' : '▸'}</span>
            </button>
            {expanded.userWaypoints && (
              <div className={css.sectionBody}>
                <UserWaypoints
                  waypoints={userWaypoints}
                  pendingCoords={pendingUserWpCoords}
                  folderVisibility={folderVisibility}
                  onCoordsConsumed={onUserWpCoordsConsumed}
                  onStartPlace={onStartPlaceUserWp}
                  onSave={onSaveUserWaypoint}
                  onDelete={onDeleteUserWaypoint}
                  onRename={onRenameUserWaypoint}
                  onMoveFolder={onMoveUserWpFolder}
                  onAddToRoute={onAddToRoute}
                  onFolderVisChange={onFolderVisChange}
                />
              </div>
            )}
          </div>

          <div className={css.section}>
            <button className={css.sectionHeader} onClick={() => toggle('layers')}>
              <span>{SECTION_LABELS.layers}</span>
              <span className={css.chevron}>{expanded.layers ? '▾' : '▸'}</span>
            </button>
            {expanded.layers && (
              <div className={css.sectionBody}>
                <LayerPanel visibility={visibility} onChange={onVisibilityChange} terrainColoring={terrainColoring} onTerrainColoringChange={onTerrainColoringChange} inFlight={inFlight} />
              </div>
            )}
          </div>

          {/* ── Altitude Filter ─────────────────────────────────── */}
          <div className={css.section}>
            <button className={css.sectionHeader} onClick={() => toggle('altitude')}>
              <span>{SECTION_LABELS.altitude}</span>
              <span className={css.chevron}>{expanded.altitude ? '▾' : '▸'}</span>
            </button>
            {expanded.altitude && (
              <div className={css.sectionBody}>
                <AltitudeSlider ceilingFt={ceilingFt} onChange={onCeilingChange} />
              </div>
            )}
          </div>

          {/* ── Settings ────────────────────────────────────────── */}
          <div className={css.section}>
            <button className={css.sectionHeader} onClick={() => toggle('settings')}>
              <span>{SECTION_LABELS.settings}</span>
              <span className={css.chevron}>{expanded.settings ? '▾' : '▸'}</span>
            </button>
            {expanded.settings && (
              <div className={css.sectionBody}>
                <SettingsPanel units={units} onUnitsChange={onUnitsChange} region={region} onRegionChange={onRegionChange} theme={theme} onThemeChange={onThemeChange} autoZoom={autoZoom} onAutoZoomChange={onAutoZoomChange} trajectoryMode={trajectoryMode} onTrajectoryModeChange={onTrajectoryModeChange} airspaceWarnLookahead={airspaceWarnLookahead} onAirspaceWarnLookaheadChange={onAirspaceWarnLookaheadChange} airspaceWarnVerticalFt={airspaceWarnVerticalFt} onAirspaceWarnVerticalFtChange={onAirspaceWarnVerticalFtChange} trafficVertFilter={trafficVertFilter} onTrafficVertFilterChange={onTrafficVertFilterChange} parkTimeout={parkTimeout} onParkTimeoutChange={onParkTimeoutChange} inFlight={inFlight} manifest={manifest} isOnline={isOnline} checking={checking} onRefresh={onRefresh} />
              </div>
            )}
          </div>

        </div>
      </div>

      {/* Tab column: avatar tab + toggle, poking right of the drawer edge */}
      <div className={`${css.tabColumn} ${open ? css.tabColumnOpen : ''}`}>
        <AccountBadge auth={auth} onOpenProfile={onOpenProfile} />
        <button
          className={css.toggle}
          onClick={() => setOpen(o => !o)}
          title={open ? 'Close menu' : 'Open menu'}
          aria-label={open ? 'Close menu' : 'Open menu'}
        >
          {open ? '✕' : '☰'}
        </button>
      </div>

      {/* Resize handle — desktop only (mouse-driven) */}
      {open && !isTouch.current && (
        <div
          className={css.resizeHandle}
          onMouseDown={onResizeMouseDown}
          title="Drag to resize"
        />
      )}
    </div>
  )
}
