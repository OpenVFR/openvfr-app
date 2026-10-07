import type { Units } from '../utils/units'
import type { AutoFlyMode } from '@open-vfr/shared/autoFlyDetect'
import type { Theme, TrajectoryMode, AirspaceWarnLookahead, TrafficVertFilter, ParkTimeoutOption } from '../db/useSettings'
import { AIRSPACE_WARN_LOOKAHEAD_OPTIONS, AIRSPACE_WARN_VERTICAL_MIN, AIRSPACE_WARN_VERTICAL_MAX, AIRSPACE_WARN_VERTICAL_STEP, TRAFFIC_VERT_FILTER_OPTIONS, PARK_TIMEOUT_OPTIONS } from '../db/useSettings'
import type { DataManifest } from '../hooks/useDataManifest'
import RegionSelector from './RegionSelector'
import { airacDataStatus, relativeTime } from '@open-vfr/shared/airac'
import { repairAppFiles } from '../utils/repairApp'
import css from './SettingsPanel.module.css'

interface Props {
  units:             Units
  onUnitsChange:     (u: Units) => void
  region:            string
  onRegionChange:    (code: string) => void
  theme:             Theme
  onThemeChange:     (t: Theme) => void
  autoZoom:              boolean
  onAutoZoomChange:      (v: boolean) => void
  trajectoryMode:        TrajectoryMode
  onTrajectoryModeChange:(v: TrajectoryMode) => void
  airspaceWarnLookahead:       AirspaceWarnLookahead
  onAirspaceWarnLookaheadChange: (v: AirspaceWarnLookahead) => void
  airspaceWarnVerticalFt:       number
  onAirspaceWarnVerticalFtChange: (v: number) => void
  trafficVertFilter:           TrafficVertFilter
  onTrafficVertFilterChange:   (v: TrafficVertFilter) => void
  parkTimeout:                 ParkTimeoutOption
  onParkTimeoutChange:         (v: ParkTimeoutOption) => void
  autoFlyMode:                 AutoFlyMode
  onAutoFlyModeChange:         (v: AutoFlyMode) => void
  /** True when aircraft is airborne (GS ≥ 30 kts); data-load controls are locked. */
  inFlight?:             boolean
  onClose?:              () => void
  manifest?:             DataManifest | null
  /** True when the browser has network access. */
  isOnline?:             boolean
  /** True while a manifest re-check fetch is in flight. */
  checking?:             boolean
  /** Re-fetch manifest.json immediately. */
  onRefresh?:            () => void
}

const THEMES: { value: Theme; label: string }[] = [
  { value: 'dark',          label: 'Dark'   },
  { value: 'light',         label: 'Light'  },
  { value: 'high-contrast', label: 'Hi-Con' },
]

export default function SettingsPanel({ units, onUnitsChange, region, onRegionChange, theme, onThemeChange, autoZoom, onAutoZoomChange, trajectoryMode, onTrajectoryModeChange, airspaceWarnLookahead, onAirspaceWarnLookaheadChange, airspaceWarnVerticalFt, onAirspaceWarnVerticalFtChange, trafficVertFilter, onTrafficVertFilterChange, parkTimeout, onParkTimeoutChange, autoFlyMode, onAutoFlyModeChange, inFlight, onClose, manifest, isOnline = true, checking = false, onRefresh }: Props) {
  return (
    <div className={css.panel}>
      <div className={css.header}>
        <span className={css.title}>Settings</span>
        {onClose && <button className={css.close} onClick={onClose} title="Close">✕</button>}
      </div>

      <div className={css.section}>
        <span className={css.label}>Distance</span>
        <div className={css.options}>
          <button
            className={`${css.opt}${units.distance === 'nm' ? ` ${css.optActive}` : ''}`}
            onClick={() => onUnitsChange({ ...units, distance: 'nm' })}
          >NM</button>
          <button
            className={`${css.opt}${units.distance === 'km' ? ` ${css.optActive}` : ''}`}
            onClick={() => onUnitsChange({ ...units, distance: 'km' })}
          >km</button>
        </div>
      </div>

      <div className={css.section}>
        <span className={css.label}>Speed</span>
        <div className={css.options}>
          <button
            className={`${css.opt}${units.speed === 'kts' ? ` ${css.optActive}` : ''}`}
            onClick={() => onUnitsChange({ ...units, speed: 'kts' })}
          >kts</button>
          <button
            className={`${css.opt}${units.speed === 'kmh' ? ` ${css.optActive}` : ''}`}
            onClick={() => onUnitsChange({ ...units, speed: 'kmh' })}
          >km/h</button>
        </div>
      </div>

      <div className={css.section}>
        <span className={css.label}>Theme</span>
        <div className={css.themeOptions}>
          {THEMES.map(({ value, label }) => (
            <button
              key={value}
              className={`${css.themeSwatch}${theme === value ? ` ${css.themeSwatchActive}` : ''}`}
              onClick={() => onThemeChange(value)}
              title={label}
            >
              <span className={css.swatchDot} data-swatch={value} />
              <span className={css.swatchLabel}>{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={css.section}>
        <span className={css.label}>Region</span>
        <div>
          <RegionSelector value={region} onChange={onRegionChange} disabled={inFlight} />
          {inFlight && (
            <span className={css.lockedNote}>Not available during flight</span>
          )}
        </div>
      </div>

      <div className={css.section}>
        <span className={css.label}>Auto-zoom</span>
        <div className={css.options}>
          <button
            className={`${css.opt}${autoZoom ? ` ${css.optActive}` : ''}`}
            onClick={() => onAutoZoomChange(!autoZoom)}
            title="Automatically zoom to takeoff and cruise zoom levels when airborne"
          >
            {autoZoom ? 'Auto-zoom ON' : 'Auto-zoom OFF'}
          </button>
        </div>
      </div>

      <div className={css.section}>
        <span className={css.label}>Trajectory</span>
        <div className={css.options}>
          <button
            className={`${css.opt}${trajectoryMode === 'time' ? ` ${css.optActive}` : ''}`}
            onClick={() => onTrajectoryModeChange('time')}
            title="Trajectory ticks at 2, 5, 10 minutes ahead"
          >Minutes</button>
          <button
            className={`${css.opt}${trajectoryMode === 'dist' ? ` ${css.optActive}` : ''}`}
            onClick={() => onTrajectoryModeChange('dist')}
            title="Trajectory ticks at 2, 5, 10 NM ahead"
          >NM</button>
        </div>
      </div>

      <div className={css.section}>
        <span className={css.label}>Airspace warning</span>
        <div className={css.optionsRow}>
          {AIRSPACE_WARN_LOOKAHEAD_OPTIONS.map(v => (
            <button
              key={v}
              className={`${css.opt}${airspaceWarnLookahead === v ? ` ${css.optActive}` : ''}`}
              onClick={() => onAirspaceWarnLookaheadChange(v)}
              title={`Warn ${v} minutes before entering controlled or restricted airspace`}
            >{v} min</button>
          ))}
        </div>
      </div>

      <div className={`${css.section} ${css.sectionColumn}`}>
        <span className={css.label}>
          Vertical buffer: {airspaceWarnVerticalFt === 0 ? 'Off' : `${airspaceWarnVerticalFt} ft`}
        </span>
        <input
          type="range"
          className={css.slider}
          min={AIRSPACE_WARN_VERTICAL_MIN}
          max={AIRSPACE_WARN_VERTICAL_MAX}
          step={AIRSPACE_WARN_VERTICAL_STEP}
          value={airspaceWarnVerticalFt}
          onChange={e => onAirspaceWarnVerticalFtChange(Number(e.target.value))}
          title={airspaceWarnVerticalFt === 0 ? 'Only warn based on climb/descent rate projection' : `Warn when within ${airspaceWarnVerticalFt} ft of an airspace floor/ceiling, regardless of climb rate`}
        />
      </div>

      <div className={css.section}>
        <span className={css.label}>Traffic vertical filter</span>
        <div className={css.optionsRow}>
          {TRAFFIC_VERT_FILTER_OPTIONS.map(v => (
            <button
              key={v}
              className={`${css.opt}${trafficVertFilter === v ? ` ${css.optActive}` : ''}`}
              onClick={() => onTrafficVertFilterChange(v)}
              title={v === 0 ? 'Show all traffic regardless of altitude' : `Hide traffic more than ${v.toLocaleString()} ft above or below current altitude`}
            >{v === 0 ? 'All' : `±${v >= 1000 ? `${v / 1000}k` : v}`}</button>
          ))}
        </div>
      </div>

      <div className={css.section}>
        <span className={css.label}>Auto flying mode</span>
        <div className={css.optionsRow}>
          {([['off', 'Off', 'Never start or stop flying mode automatically'],
             ['ask', 'Ask', 'Show a prompt when takeoff or landing is detected'],
             ['auto', 'Auto', 'Start and stop flying mode automatically on detected takeoff and landing (GPS only)']] as const).map(([v, label, title]) => (
            <button
              key={v}
              className={`${css.opt}${autoFlyMode === v ? ` ${css.optActive}` : ''}`}
              onClick={() => onAutoFlyModeChange(v)}
              title={title}
            >{label}</button>
          ))}
        </div>
      </div>

      <div className={css.section}>
        <span className={css.label}>Log split timeout</span>
        <div className={css.optionsRow}>
          {PARK_TIMEOUT_OPTIONS.map(v => (
            <button
              key={v}
              className={`${css.opt}${parkTimeout === v ? ` ${css.optActive}` : ''}`}
              onClick={() => onParkTimeoutChange(v)}
              title={v === 0 ? 'Each touch-and-go creates a separate flight log' : `Keep one flight log if airborne again within ${v / 60} min of landing`}
            >{v === 0 ? 'Per leg' : v < 60 ? `${v}s` : `${v / 60} min`}</button>
          ))}
        </div>
      </div>

      {manifest && Object.keys(manifest.countries).length > 0 && (
        <div className={`${css.section} ${css.sectionColumn}`}>
          <div className={css.dataHeader}>
            <span className={css.label}>Data versions</span>
            <div className={css.dataHeaderRight}>
              <span className={`${css.onlineChip} ${isOnline ? css.onlineChipOnline : css.onlineChipOffline}`}>
                {isOnline ? 'Online' : 'Offline'}
              </span>
              {onRefresh && (
                <button
                  className={css.refreshBtn}
                  onClick={onRefresh}
                  disabled={checking || inFlight}
                  title={inFlight ? 'Not available during flight' : 'Check for updated aviation data'}
                >
                  {checking ? '…' : '↻'}
                </button>
              )}
            </div>
          </div>
          <div className={css.dataVersions}>
            {Object.entries(manifest.countries)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([country, datasets]) => {
                const airspace = datasets['airspace']
                // A missing cycle is shown as "unknown", never silently as fine:
                // that is exactly how a stalled refresh pipeline looks.
                const st = airacDataStatus(airspace?.airac_cycle)
                const loadedMs = airspace?.loaded_at ? Date.parse(airspace.loaded_at) : null
                const updatedMs = loadedMs ?? (manifest.generated_at ? Date.parse(manifest.generated_at) : null)
                const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })
                const badgeClass = st.state === 'current' ? css.dataVersionBadgeOk
                  : st.state === 'outdated' ? css.dataVersionBadgeStale : css.dataVersionBadgeUnknown
                return (
                  <div key={country} className={css.dataVersionBlock}>
                    <div className={css.dataVersionRow}>
                      <span className={css.dataVersionCountry}>{country.toUpperCase()}</span>
                      <span className={css.dataVersionBadge}>{st.cycle ? `AIRAC ${st.cycle}` : 'AIRAC ?'}</span>
                      <span className={`${css.dataVersionBadge} ${badgeClass}`}>
                        {st.state === 'current' ? 'Current' : st.state === 'outdated' ? 'Outdated' : 'Unknown'}
                      </span>
                    </div>
                    <div className={css.dataVersionDetail}>
                      {st.validFromMs != null && st.validToMs != null && (
                        <span>Valid {fmtDay(st.validFromMs)} – {fmtDay(st.validToMs - 86_400_000)}</span>
                      )}
                      {updatedMs != null && (
                        <span>{loadedMs != null ? 'Updated' : 'Published'} {relativeTime(updatedMs)}</span>
                      )}
                      <span>Next AIRAC {st.nextCycle} {fmtDay(st.nextEffectiveMs)} ({relativeTime(st.nextEffectiveMs)})</span>
                    </div>
                    {st.state !== 'current' && (
                      <div className={css.dataVersionNote}>
                        {st.state === 'outdated'
                          ? `AIRAC ${st.inForceCycle} in force since ${fmtDay(st.inForceSinceMs)}: airspace shown may be superseded. Check current AIP/NOTAM.`
                          : 'Server reports no AIRAC cycle for this airspace data; currency cannot be confirmed. Check current AIP/NOTAM.'}
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        </div>
      )}

      <div className={css.section}>
        <span className={css.label}>App files</span>
        <button
          className={css.opt}
          disabled={inFlight || !isOnline}
          title={inFlight ? 'Not available during flight'
            : !isOnline ? 'Needs a connection to re-download the app'
            : 'Re-download app files and cached map data. Routes, aircraft and settings are kept.'}
          onClick={() => {
            if (window.confirm(
              'Repair app files?\n\nThis clears the cached app and map data and reloads. ' +
              'Your routes, aircraft, waypoints, logs and settings are kept. Needs a connection to re-download.',
            )) {
              void repairAppFiles()
            }
          }}
        >Repair &amp; reload</button>
      </div>
    </div>
  )
}
