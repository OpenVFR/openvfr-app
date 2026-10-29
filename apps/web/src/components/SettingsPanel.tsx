import { useEffect, useState } from 'react'
import { parkTimeoutLabel } from '@open-vfr/shared/parkTimeout'
import type { Units } from '../utils/units'
import type { AutoFlyMode } from '@open-vfr/shared/autoFlyDetect'
import type { Theme, TrajectoryMode, AirspaceWarnLookahead, TrafficVertFilter, ParkTimeoutOption } from '../db/useSettings'
import { AIRSPACE_WARN_LOOKAHEAD_OPTIONS, AIRSPACE_WARN_VERTICAL_MIN, AIRSPACE_WARN_VERTICAL_MAX, AIRSPACE_WARN_VERTICAL_STEP, TRAFFIC_VERT_FILTER_OPTIONS, PARK_TIMEOUT_OPTIONS } from '../db/useSettings'
import type { DataManifest } from '../hooks/useDataManifest'
import RegionSelector from './RegionSelector'
import type { AvailableCountry } from '@open-vfr/shared/countries'
import { airacDataStatus, relativeTime } from '@open-vfr/shared/airac'
import { describeGpsAltitudeReference, gpsAltitudeReferenceStatus, subscribeGpsAltitudeReference } from '@open-vfr/shared/gpsAltitudeReference'
import { FULL_CREDITS_LINK } from '@open-vfr/shared/attributionSources'
import { SITE_BASE_URL } from '../utils/env'
import { SPONSOR } from '@open-vfr/shared/sponsor'

/** Whether GPS altitudes are geoid-corrected, and whether that was verified
 *  on the ground (@open-vfr/shared/gpsAltitudeReference). */
function GpsAltitudeReferenceRow() {
  const [st, setSt] = useState(gpsAltitudeReferenceStatus)
  useEffect(() => subscribeGpsAltitudeReference(() => setSt(gpsAltitudeReferenceStatus())), [])
  const d = describeGpsAltitudeReference(st, (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))
  return (
    <div className={css.section} title={d.detail}>
      <span className={css.label}>GPS altitude</span>
      <span className={`${css.infoValue}${d.mismatch ? ` ${css.infoWarn}` : ''}`}>{d.mismatch ? '\u26a0 ' : ''}{d.value}</span>
    </div>
  )
}
import { useMsaMargins, useAlertBanners } from '../db/useSettings'
import { AIRSPACE_CATEGORIES, type AlertLevel } from '@open-vfr/shared/airspaceAlertLevel'
import { DEFAULT_MSA_MARGINS, MSA_ABEAM_RANGE_NM, MSA_CLEARANCE_RANGE_FT } from '@open-vfr/shared/msaMargins'
import { repairAppFiles } from '../utils/repairApp'
import css from './SettingsPanel.module.css'

interface Props {
  units:             Units
  onUnitsChange:     (u: Units) => void
  countries:         AvailableCountry[] | null
  selectedCountries: string[]
  onSelectedCountriesChange: (codes: string[]) => void
  theme:             Theme
  onThemeChange:     (t: Theme) => void
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
  recordSimulatedFlights:      boolean
  onRecordSimulatedFlightsChange: (v: boolean) => void
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

/** On/off for the optional in-flight banners (obstacles, aerodrome nearby, airspace entered/left). */
function AlertBannerSettings() {
  const [b, setB] = useAlertBanners()
  const row = (label: string, key: 'obstacles' | 'aerodromes' | 'airspaceEvents' | 'suppressOnCourse') => (
    <div className={css.section}>
      <span className={css.label}>{label}</span>
      <div className={css.optionsRow}>
        {([false, true] as const).map(v => (
          <button
            key={String(v)}
            className={`${css.opt}${b[key] === v ? ` ${css.optActive}` : ''}`}
            onClick={() => setB({ [key]: v })}
          >{v ? 'On' : 'Off'}</button>
        ))}
      </div>
    </div>
  )
  return (
    <>
      {row('Obstacles ahead banner', 'obstacles')}
      {row('Aerodrome nearby banner', 'aerodromes')}
      {row('Airspace entered / left', 'airspaceEvents')}
      <div className={`${css.section} ${css.sectionColumn}`}>
        <span className={css.label}>Airspace warning level</span>
        {AIRSPACE_CATEGORIES.map(c => (
          <div key={c.key} className={css.section}>
            <span className={css.label}>{c.label}</span>
            <div className={css.optionsRow}>
              {(['alert', 'info', ...(c.canIgnore ? ['ignore'] : [])] as AlertLevel[]).map(l => (
                <button
                  key={l}
                  className={`${css.opt}${b.airspaceLevels[c.key] === l ? ` ${css.optActive}` : ''}`}
                  onClick={() => setB({ airspaceLevels: { ...b.airspaceLevels, [c.key]: l } })}
                  title={l === 'alert' ? 'Full warning card' : l === 'info' ? 'Quiet one-line chip' : 'No look-ahead warning'}
                >{l === 'alert' ? 'Alert' : l === 'info' ? 'Info' : 'Ignore'}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {row('Mute airspace warnings on planned course', 'suppressOnCourse')}
    </>
  )
}

/** Terrain/obstacle margins for the MSA line, below-MSA warnings and auto cruise level. */
function MsaMarginsSettings() {
  const [m, setM] = useMsaMargins()
  const row = (label: string, value: number, unit: string, min: number, max: number, step: number, key: 'abeamNm' | 'terrainClearanceFt' | 'obstacleClearanceFt', title: string) => (
    <div className={`${css.section} ${css.sectionColumn}`} title={title}>
      <span className={css.label}>{label}: {value} {unit}</span>
      <input type="range" className={css.slider} min={min} max={max} step={step} value={value}
        onChange={e => setM({ [key]: Number(e.target.value) })} />
    </div>
  )
  return (
    <>
      {row('MSA abeam', m.abeamNm, 'NM', MSA_ABEAM_RANGE_NM[0], MSA_ABEAM_RANGE_NM[1], 0.5, 'abeamNm', `Terrain is checked this far either side of the route (default ${DEFAULT_MSA_MARGINS.abeamNm} NM)`)}
      {row('Terrain clearance', m.terrainClearanceFt, 'ft', MSA_CLEARANCE_RANGE_FT[0], MSA_CLEARANCE_RANGE_FT[1], 100, 'terrainClearanceFt', `Minimum height above the highest terrain (default ${DEFAULT_MSA_MARGINS.terrainClearanceFt} ft)`)}
      {row('Obstacle clearance', m.obstacleClearanceFt, 'ft', MSA_CLEARANCE_RANGE_FT[0], MSA_CLEARANCE_RANGE_FT[1], 100, 'obstacleClearanceFt', `Minimum height above the highest obstacle tip (default ${DEFAULT_MSA_MARGINS.obstacleClearanceFt} ft)`)}
    </>
  )
}

export default function SettingsPanel({ units, onUnitsChange, countries, selectedCountries, onSelectedCountriesChange, theme, onThemeChange, trajectoryMode, onTrajectoryModeChange, airspaceWarnLookahead, onAirspaceWarnLookaheadChange, airspaceWarnVerticalFt, onAirspaceWarnVerticalFtChange, trafficVertFilter, onTrafficVertFilterChange, parkTimeout, onParkTimeoutChange, recordSimulatedFlights, onRecordSimulatedFlightsChange, autoFlyMode, onAutoFlyModeChange, inFlight, onClose, manifest, isOnline = true, checking = false, onRefresh }: Props) {
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
        <span className={css.label}>Country</span>
        <div>
          <RegionSelector countries={countries} selected={selectedCountries} onChange={onSelectedCountriesChange} disabled={inFlight} />
          {inFlight && (
            <span className={css.lockedNote}>Not available during flight</span>
          )}
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

      <details className={css.group}>
        <summary className={css.groupTitle}>Warnings &amp; margins</summary>
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

      <AlertBannerSettings />

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

      <MsaMarginsSettings />
      </details>

      <details className={css.group}>
        <summary className={css.groupTitle}>Flying</summary>
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
            >{parkTimeoutLabel(v)}</button>
          ))}
        </div>
      </div>

      <div className={css.section}>
        <span className={css.label}>Log simulated flights</span>
        <div className={css.optionsRow}>
          {([false, true] as const).map(v => (
            <button
              key={String(v)}
              className={`${css.opt}${recordSimulatedFlights === v ? ` ${css.optActive}` : ''}`}
              onClick={() => onRecordSimulatedFlightsChange(v)}
              title={v
                ? 'Also log keyboard / external simulator flights (for testing). They are tagged SIM, stay in this browser and are left out of totals.'
                : 'Simulator flights are not logged'}
            >{v ? 'On' : 'Off'}</button>
          ))}
        </div>
      </div>
      </details>

      <details className={css.group}>
        <summary className={css.groupTitle}>Data</summary>
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

      <GpsAltitudeReferenceRow />
      </details>

      <details className={css.group}>
        <summary className={css.groupTitle}>App</summary>
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

      <div className={css.section}>
        <span className={css.label}>Supported by</span>
        <nav className={css.aboutLinks} aria-label="Sponsor">
          <a href={SPONSOR.url} target="_blank" rel="noopener noreferrer">{SPONSOR.name}</a>
        </nav>
      </div>

      {/* Credits for every data source are also behind the map's (i) button. */}
      <div className={css.section}>
        <span className={css.label}>About</span>
        <nav className={css.aboutLinks} aria-label="About">
          <a href={FULL_CREDITS_LINK.url} target="_blank" rel="noopener noreferrer">Data sources &amp; licences</a>
          {SITE_BASE_URL && (
            <>
              <a href={`${SITE_BASE_URL}/privacy`} target="_blank" rel="noopener noreferrer">Privacy</a>
              <a href={`${SITE_BASE_URL}/terms`} target="_blank" rel="noopener noreferrer">Terms &amp; Disclaimer</a>
            </>
          )}
        </nav>
      </div>
      </details>

    </div>
  )
}
