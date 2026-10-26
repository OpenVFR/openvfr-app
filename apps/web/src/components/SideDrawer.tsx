import { memo, useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import LayerPanel, { type BasemapMode } from './LayerPanel'
import SettingsPanel from './SettingsPanel'
import RoutePlan from './RoutePlan'
import PreflightWarnings from './PreflightWarnings'
import RouteLibrary from './RouteLibrary'
import AircraftLibrary from './AircraftLibrary'
import FuelPlan from './FuelPlan'
import FindFeature, { type FindResult } from './FindFeature'
import AccountBadge from './AccountBadge'
import type { AuthState } from '../hooks/useAuth'
import type { AvailableCountry } from '@open-vfr/shared/countries'
import UserWaypoints from './UserWaypoints'
import FlightLogs from './FlightLogs'
import type { Units } from '../utils/units'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride, AircraftProfileDocType, UserWaypointDocType } from '../db/index'
import type { AutoFlyMode } from '@open-vfr/shared/autoFlyDetect'
import type { Theme, TrajectoryMode, AirspaceWarnLookahead, TerrainColoringSettings, TrafficVertFilter, ParkTimeoutOption } from '../db/useSettings'
import type { DataManifest } from '../hooks/useDataManifest'
import { useTakeoffTime, useGlobalWind } from '../db/useSettings'
import { useRouteWinds } from '../hooks/useRouteWinds'
import css from './SideDrawer.module.css'

interface Props {
  // Map controls
  visibility: Record<string, boolean>
  onVisibilityChange: (groupId: string, on: boolean) => void
  ceilingFt: number
  onCeilingChange: (ft: number) => void
  basemapMode: BasemapMode
  onBasemapModeChange: (m: BasemapMode) => void
  satelliteLocked?: boolean
  units: Units
  onUnitsChange: (u: Units) => void
  countries: AvailableCountry[] | null
  selectedCountries: string[]
  onSelectedCountriesChange: (codes: string[]) => void
  theme: Theme
  onThemeChange: (t: Theme) => void
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
  recordSimulatedFlights: boolean
  onRecordSimulatedFlightsChange: (v: boolean) => void
  onParkTimeoutChange: (v: ParkTimeoutOption) => void
  autoFlyMode: AutoFlyMode
  onAutoFlyModeChange: (v: AutoFlyMode) => void
  /** True when aircraft is airborne (GS ≥ 30 kts); locks data-load controls. */
  inFlight?: boolean
  manifest?: DataManifest | null
  isOnline?: boolean
  checking?: boolean
  onRefresh?: () => void
  // Route plan
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  /** The route's end is selected: clicks on map features append them. */
  extending: boolean
  /** Stops extending the route (Done). */
  onStopExtending: () => void
  /** Leg whose editor is open in the route table (also selected by clicking the leg on the map). */
  selectedLeg: number | null
  onSelectLeg: (leg: number | null) => void
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
  onInsertInRoute: (wp: RouteWaypoint, afterIdx: number) => void
  // Aircraft selection
  selectedAircraftId?: string
  selectedAircraftProfile?: AircraftProfileDocType
  /** ICAOs with a TAF trend change due soon, flagged in the route list. */
  tafWarnIcaos?: string[]
  onSelectAircraft?: (id: string | null) => void
  // Search / fly-to
  onFlyTo: (r: FindResult) => void
  // Flight logs
  selectedLogId: string | null
  /** `atTs`: open the log inspecting the recorded point at that time (an event picked in the list). */
  onSelectLog: (id: string, atTs?: number) => void
  onClearLog: () => void
  // User waypoints
  userWaypoints: UserWaypointDocType[]
  pendingUserWpCoords: { lng: number; lat: number } | null
  folderVisibility: Record<string, boolean>
  onUserWpCoordsConsumed: () => void
  onStartPlaceUserWp: () => void
  onSaveUserWaypoint: (wp: Omit<UserWaypointDocType, 'id' | 'updatedAt'>) => void
  onDeleteUserWaypoint: (id: string) => void
  onRenameUserWaypoint: (id: string, name: string, folder?: string) => void
  onMoveUserWpFolder: (id: string, folder: string) => void
  onFolderVisChange: (folder: string, visible: boolean) => void
  onSaveHereUserWaypoint: (name: string, lng: number, lat: number) => void
  /** Flying with a position fix (the empty-route hint then points at Direct To). */
  inFlightRoute: boolean
  auth: AuthState
  onOpenProfile: () => void
}

const SECTION_LABELS = {
  route:         'Route',
  preflight:     'Pre-flight Check',
  fuel:          'Fuel Plan',
  flightLogs:    'Flight Logs',
  aircraft:      'Aircraft',
  userWaypoints: 'Places',
  layers:        'Layers',
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

function SideDrawer({
  visibility, onVisibilityChange,
  ceilingFt, onCeilingChange,
  basemapMode, onBasemapModeChange, satelliteLocked,
  units, onUnitsChange,
  countries, selectedCountries, onSelectedCountriesChange,
  theme, onThemeChange,
  trajectoryMode, onTrajectoryModeChange,
  airspaceWarnLookahead, onAirspaceWarnLookaheadChange,
  airspaceWarnVerticalFt, onAirspaceWarnVerticalFtChange,
  terrainColoring, onTerrainColoringChange,
  trafficVertFilter, onTrafficVertFilterChange,
  parkTimeout, onParkTimeoutChange, recordSimulatedFlights, onRecordSimulatedFlightsChange, autoFlyMode, onAutoFlyModeChange,
  inFlight,
  manifest,
  isOnline,
  checking,
  onRefresh,
  waypoints, legOverrides, extending, onStopExtending, selectedLeg, onSelectLeg,
  onUndo, onRedo, canUndo, canRedo, onClear, onReplace, onLoadRoute, activeRouteId, onActiveRouteIdChange, onSetLegOverride, onSetWaypointNote,
  onAddToRoute, onInsertInRoute,
  selectedAircraftId, selectedAircraftProfile, tafWarnIcaos, onSelectAircraft,
  onFlyTo,
  selectedLogId, onSelectLog, onClearLog,
  userWaypoints, pendingUserWpCoords, folderVisibility,
  onUserWpCoordsConsumed, onStartPlaceUserWp,
  onSaveUserWaypoint, onDeleteUserWaypoint, onRenameUserWaypoint, onMoveUserWpFolder,
  onFolderVisChange, onSaveHereUserWaypoint, inFlightRoute,
  auth,
  onOpenProfile,
}: Props) {
  // First visit: the pane starts open (so what it offers is visible) with
  // every section folded to its header. Phone-sized screens start closed:
  // there the pane overlays the map. Later visits restore the saved state.
  const [open, setOpen]         = useState(() => lsGet(LS_OPEN, typeof window === 'undefined' || window.innerWidth >= 700))
  const [width, setWidth]       = useState(() => lsGet(LS_WIDTH, DEFAULT_WIDTH))
  const [expanded, setExpanded] = useState<Record<Section, boolean>>(() =>
    lsGet(LS_EXPANDED, { route: false, preflight: false, fuel: false, flightLogs: false, aircraft: false, userWaypoints: false, layers: false, settings: false })
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

  // Auto-open the drawer when a route exists or user WP coords arrive.
  // (Clicked map features show in FeatureCard beside the map, not here.)
  // Planning inputs + effective per-leg wind, shared by the route table, pre-flight check and fuel plan.
  const [takeoffTime, setTakeoffTime] = useTakeoffTime()
  const [globalWind, setGlobalWind] = useGlobalWind()
  const routeWinds = useRouteWinds(waypoints, legOverrides, selectedAircraftProfile?.cruiseAltFt || undefined, selectedAircraftProfile?.cruiseIas || undefined, takeoffTime, globalWind)
  useEffect(() => {
    if (waypoints.length > 0) { setOpen(true) }
  }, [waypoints.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  // A leg picked on the map opens the pane at the Route section (the table
  // scrolls its row into view).
  useEffect(() => {
    if (selectedLeg == null) return
    setOpen(true)
    setExpanded(e => (e.route ? e : { ...e, route: true }))
  }, [selectedLeg])

  // Starting or extending the route on the map shows the Route section, so
  // the points appear as they are added.
  useEffect(() => {
    if (!extending) return
    setOpen(true)
    setExpanded(e => (e.route ? e : { ...e, route: true }))
  }, [extending])

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
  // Route header aircraft chip: open the Aircraft section and bring it into view.
  const aircraftRef = useRef<HTMLButtonElement>(null)
  const showAircraft = () => {
    setExpanded(e => (e.aircraft ? e : { ...e, aircraft: true }))
    requestAnimationFrame(() => aircraftRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }
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
          <FindFeature onResult={onFlyTo} onAddToRoute={onAddToRoute} routeWaypoints={waypoints} onInsertInRoute={onInsertInRoute} places={userWaypoints} onSavePlace={(lng, lat) => onSaveHereUserWaypoint('', lng, lat)} />
        </div>
        <div className={css.scroll}>

          {/* ── Route: the working route, as a document (name, Save, Open) ── */}
          <div className={css.section}>
            <button className={css.sectionHeader} onClick={() => toggle('route')}>
              <span>{SECTION_LABELS.route}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* The aircraft sets the plan's speeds, fuel and levels, so it
                    sits with the route; the Aircraft section manages profiles. */}
                <span
                  role="button"
                  className={`${css.acChip}${selectedAircraftProfile ? '' : ` ${css.acChipNone}`}`}
                  title={selectedAircraftProfile
                    ? `Aircraft for this plan: ${selectedAircraftProfile.name}. Click to change.`
                    : 'No aircraft: pick one for speeds, fuel and times en route'}
                  onClick={(e) => { e.stopPropagation(); showAircraft() }}
                >
                  {selectedAircraftProfile ? (selectedAircraftProfile.registration || selectedAircraftProfile.name) : 'No aircraft'} {'\u25be'}
                </span>
                {extending && (
                  <span
                    role="button"
                    className={`${css.planPill} ${css.planPillActive}`}
                    title="Stop adding points (or click empty map, or press Esc)"
                    onClick={(e) => { e.stopPropagation(); onStopExtending() }}
                  >
                    Done
                  </span>
                )}
                <span className={css.chevron}>{expanded.route ? '▾' : '▸'}</span>
              </span>
            </button>
            {expanded.route && (
              <div className={css.sectionBody}>
                <RouteLibrary
                  currentWaypoints={waypoints}
                  currentLegOverrides={legOverrides}
                  currentAircraftId={selectedAircraftId ?? ''}
                  onLoad={onLoadRoute}
                  onClear={onClear}
                  activeRouteId={activeRouteId}
                  onActiveRouteIdChange={onActiveRouteIdChange}
                >
                  {hasRoute ? (
                    <RoutePlan
                      selectedLeg={selectedLeg}
                      onSelectLeg={onSelectLeg}
                      waypoints={waypoints}
                      tafWarnIcaos={tafWarnIcaos}
                      legOverrides={legOverrides}
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
                      defaultAltFt={selectedAircraftProfile?.cruiseAltFt || undefined}
                      defaultSpeedKts={selectedAircraftProfile?.cruiseIas || undefined}
                      takeoffTime={takeoffTime}
                      setTakeoffTime={setTakeoffTime}
                      globalWind={globalWind}
                      setGlobalWind={setGlobalWind}
                      routeWinds={routeWinds}
                    />
                  ) : (
                    <div className={css.routeEmpty}>
                      <p>{inFlightRoute
                        ? 'No route. Use Direct To, or open a saved route.'
                        : 'No route. Click an aerodrome or navaid on the map and choose "Start route here", search above, or open a saved route.'}</p>
                      <div className={css.routeEmptyActions}>
                        {canUndo && (
                          <button onClick={onUndo} title="Undo last route change (Ctrl+Z)">↶ Undo</button>
                        )}
                      </div>
                    </div>
                  )}
                </RouteLibrary>
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
                    legWinds={routeWinds.effective}
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
                    legWinds={routeWinds.effective}
                  />
                </div>
              )}
            </div>
          )}

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
                  routeWaypoints={waypoints}
                  onInsertInRoute={onInsertInRoute}
                  onShowOnMap={(lng, lat) => onFlyTo({ kind: 'LL', id: '', name: '', sub: '', lng, lat })}
                  onFolderVisChange={onFolderVisChange}
                />
              </div>
            )}
          </div>
          {/* ── Aircraft ───────────────────────────────────────── */}
          <div className={css.section}>
            <button ref={aircraftRef} className={css.sectionHeader} onClick={() => toggle('aircraft')}>
              <span>{SECTION_LABELS.aircraft}</span>
              <span className={css.chevron}>{expanded.aircraft ? '▾' : '▸'}</span>
            </button>
            {expanded.aircraft && (
              <div className={css.sectionBody}>
                <AircraftLibrary selectedId={selectedAircraftId} onSelect={onSelectAircraft} />
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
                  importAircraft={selectedAircraftId ? { id: selectedAircraftId, registration: selectedAircraftProfile?.registration ?? '' } : undefined}
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
                <LayerPanel visibility={visibility} onChange={onVisibilityChange} terrainColoring={terrainColoring} onTerrainColoringChange={onTerrainColoringChange} inFlight={inFlight} basemapMode={basemapMode} onBasemapModeChange={onBasemapModeChange} satelliteLocked={satelliteLocked} ceilingFt={ceilingFt} onCeilingChange={onCeilingChange} />
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
                <SettingsPanel units={units} onUnitsChange={onUnitsChange} countries={countries} selectedCountries={selectedCountries} onSelectedCountriesChange={onSelectedCountriesChange} theme={theme} onThemeChange={onThemeChange} trajectoryMode={trajectoryMode} onTrajectoryModeChange={onTrajectoryModeChange} airspaceWarnLookahead={airspaceWarnLookahead} onAirspaceWarnLookaheadChange={onAirspaceWarnLookaheadChange} airspaceWarnVerticalFt={airspaceWarnVerticalFt} onAirspaceWarnVerticalFtChange={onAirspaceWarnVerticalFtChange} trafficVertFilter={trafficVertFilter} onTrafficVertFilterChange={onTrafficVertFilterChange} parkTimeout={parkTimeout} onParkTimeoutChange={onParkTimeoutChange} recordSimulatedFlights={recordSimulatedFlights} onRecordSimulatedFlightsChange={onRecordSimulatedFlightsChange} autoFlyMode={autoFlyMode} onAutoFlyModeChange={onAutoFlyModeChange} inFlight={inFlight} manifest={manifest} isOnline={isOnline} checking={checking} onRefresh={onRefresh} />
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

// Memoised (callers pass stable props via useStableProps): MapView re-renders on
// every GPS tick and the drawer is expensive to render.
export default memo(SideDrawer)
