import type React from 'react'
import css from './FeaturePopup.module.css'

// ── Feature type definitions ──────────────────────────────────────────────────
// Each variant carries only the properties available in its GeoJSON source.

export interface NavaidFeature {
  kind: 'navaid'
  id: string
  name: string
  navaid_type: string   // e.g. DVOR, DVOR/DME, NDB, HOMER
  freq_str: string      // formatted frequency, e.g. "116.45" or "340.0"
  has_dme: boolean
  elevation_ft: number | null
}

export interface WaypointFeature {
  kind: 'waypoint'
  id: string
  name: string
  wp_type: string       // MRP | RP | ENR | ICAO
  aerodrome: string | null
}

export interface ObstacleFeature {
  kind: 'obstacle'
  obstacleKind: string  // wind_turbine | tower | chimney | building | other
  name: string
  elevation_ft: number
  height_m: number      // AGL height in metres; 0 if unknown
}

export interface LandmarkFeature {
  kind: 'landmark'
  landmarkKind: string  // church | mast | windmill | water_tower | chimney
  name: string
  height_m: number      // 0 if not tagged in OSM
}

export interface TrafficFeature {
  kind: 'traffic'
  icao24: string
  callsign: string | null
  altFt: number
  speedKts: number
  trackDeg: number
  vertFpm: number
  relAltFt: number | null
  category: number | null
  onGround: boolean
}

export interface RegionalNotamFeature {
  kind: 'regionalNotam'
  notamId:        string       // NOTAM number, e.g. "B2671/26"
  text:           string
  effective:      string | null
  expires:        string | null
  classification: string | null
  radiusNm:       number | null
}

export type PointFeature =
  | NavaidFeature
  | WaypointFeature
  | ObstacleFeature
  | LandmarkFeature
  | TrafficFeature
  | RegionalNotamFeature

// ── Label maps ────────────────────────────────────────────────────────────────

const WP_TYPE_LABEL: Record<string, string> = {
  MRP:  'Mandatory Reporting Point',
  RP:   'VFR Reporting Point',
  ENR:  'En-Route Waypoint',
  ICAO: 'ICAO Waypoint',
}

const OBSTACLE_KIND_LABEL: Record<string, string> = {
  wind_turbine: 'Wind Turbine',
  tower:        'Tower / Mast',
  chimney:      'Chimney',
  building:     'Building',
  other:        'Obstacle',
}

const LANDMARK_KIND_LABEL: Record<string, string> = {
  church:      'Church',
  mast:        'Radio / Telecom Mast',
  windmill:    'Windmill',
  water_tower: 'Water Tower',
  chimney:     'Chimney (OSM)',
}

// ── Sub-renderers ─────────────────────────────────────────────────────────────

function NavaidHeader({ f }: { f: NavaidFeature }) {
  return (
    <div className={css.headerContent}>
      <span className={css.bigId}>{f.id}</span>
      <span className={css.typeTag}>{f.navaid_type}</span>
    </div>
  )
}

function NavaidBody({ f }: { f: NavaidFeature }) {
  return (
    <div className={css.body}>
      {f.name && <div className={css.name}>{f.name}</div>}
      <div className={css.row}>
        <span className={css.label}>Frequency</span>
        <span className={css.value}>{f.freq_str}</span>
      </div>
      {f.has_dme && (
        <div className={css.row}>
          <span className={css.label}>Co-located</span>
          <span className={css.value}>DME</span>
        </div>
      )}
      {f.elevation_ft != null && (
        <div className={css.row}>
          <span className={css.label}>Elevation</span>
          <span className={css.value}>{f.elevation_ft} ft AMSL</span>
        </div>
      )}
    </div>
  )
}

function WaypointHeader({ f }: { f: WaypointFeature }) {
  return (
    <div className={css.headerContent}>
      <span className={css.bigId}>{f.id}</span>
      <span className={css.typeTag}>{f.wp_type}</span>
    </div>
  )
}

function WaypointBody({ f }: { f: WaypointFeature }) {
  const typeLabel = WP_TYPE_LABEL[f.wp_type] ?? f.wp_type
  return (
    <div className={css.body}>
      {f.name && f.name !== f.id && <div className={css.name}>{f.name}</div>}
      <div className={css.row}>
        <span className={css.label}>Type</span>
        <span className={css.value}>{typeLabel}</span>
      </div>
      {f.aerodrome && (
        <div className={css.row}>
          <span className={css.label}>Aerodrome</span>
          <span className={css.value}>{f.aerodrome}</span>
        </div>
      )}
    </div>
  )
}

function ObstacleHeader({ f }: { f: ObstacleFeature }) {
  const label = OBSTACLE_KIND_LABEL[f.obstacleKind] ?? 'Obstacle'
  return (
    <div className={css.headerContent}>
      <span className={css.typeTag}>{label}</span>
    </div>
  )
}

function ObstacleBody({ f }: { f: ObstacleFeature }) {
  return (
    <div className={css.body}>
      {f.name && <div className={css.name}>{f.name}</div>}
      <div className={css.row}>
        <span className={css.label}>Elevation AMSL</span>
        <span className={css.value}>{f.elevation_ft} ft</span>
      </div>
      {f.height_m > 0 && (
        <div className={css.row}>
          <span className={css.label}>Height AGL</span>
          <span className={css.value}>
            {f.height_m} m ({Math.round(f.height_m * 3.28084)} ft)
          </span>
        </div>
      )}
      <div className={css.source}>© openAIP (CC BY-NC 4.0)</div>
    </div>
  )
}

function LandmarkHeader({ f }: { f: LandmarkFeature }) {
  const label = LANDMARK_KIND_LABEL[f.landmarkKind] ?? 'Landmark'
  return (
    <div className={css.headerContent}>
      <span className={css.typeTag}>{label}</span>
    </div>
  )
}

function LandmarkBody({ f }: { f: LandmarkFeature }) {
  return (
    <div className={css.body}>
      {f.name && <div className={css.name}>{f.name}</div>}
      {f.height_m > 0 && (
        <div className={css.row}>
          <span className={css.label}>Height</span>
          <span className={css.value}>{f.height_m} m</span>
        </div>
      )}
      <div className={css.source}>© OpenStreetMap contributors (ODbL)</div>
    </div>
  )
}

const CATEGORY_LABEL: Record<number, string> = {
  0: 'No info', 1: 'Light', 2: 'Small', 3: 'Large', 4: 'B757-class',
  5: 'Heavy', 6: 'High-perf', 7: 'Rotorcraft', 8: 'Glider',
  9: 'Lighter-than-air', 10: 'Parachutist', 11: 'Ultralight',
  12: 'Ultralight', 13: 'UAV', 14: 'Space vehicle',
}

function TrafficHeader({ f }: { f: TrafficFeature }) {
  return (
    <div className={css.headerContent}>
      <span className={css.bigId}>{f.callsign ?? f.icao24}</span>
      {f.callsign && <span className={css.typeTag}>{f.icao24.toUpperCase()}</span>}
      <span className={css.typeTag}>ADS-B</span>
    </div>
  )
}

function TrafficBody({ f }: { f: TrafficFeature }) {
  const vertArrow = f.vertFpm > 100 ? ' ↑' : f.vertFpm < -100 ? ' ↓' : ' →'
  return (
    <div className={css.body}>
      <div className={css.row}>
        <span className={css.label}>Altitude</span>
        <span className={css.value}>{f.onGround ? 'On ground' : `${f.altFt.toLocaleString()} ft${vertArrow}`}</span>
      </div>
      {!f.onGround && f.relAltFt !== null && (
        <div className={css.row}>
          <span className={css.label}>Relative alt</span>
          <span className={css.value}>{f.relAltFt > 0 ? '+' : ''}{f.relAltFt.toLocaleString()} ft</span>
        </div>
      )}
      <div className={css.row}>
        <span className={css.label}>Speed</span>
        <span className={css.value}>{f.speedKts} kt</span>
      </div>
      <div className={css.row}>
        <span className={css.label}>Track</span>
        <span className={css.value}>{f.trackDeg}°</span>
      </div>
      {!f.onGround && (
        <div className={css.row}>
          <span className={css.label}>Vert rate</span>
          <span className={css.value}>{f.vertFpm > 0 ? '+' : ''}{f.vertFpm.toLocaleString()} fpm</span>
        </div>
      )}
      {f.category !== null && f.category > 0 && (
        <div className={css.row}>
          <span className={css.label}>Category</span>
          <span className={css.value}>{CATEGORY_LABEL[f.category] ?? `Cat ${f.category}`}</span>
        </div>
      )}
      <div className={css.source}>© OpenSky Network</div>
    </div>
  )
}

// (former RegionalNotamHeader/RegionalNotamBody removed -- see PointFeature comment above)

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  feature: PointFeature
  onClose: () => void
}

export default function FeaturePopup({ feature: f, onClose }: Props) {
  let header: React.ReactNode
  let body: React.ReactNode

  switch (f.kind) {
    case 'navaid':
      header = <NavaidHeader f={f} />
      body   = <NavaidBody   f={f} />
      break
    case 'waypoint':
      header = <WaypointHeader f={f} />
      body   = <WaypointBody   f={f} />
      break
    case 'obstacle':
      header = <ObstacleHeader f={f} />
      body   = <ObstacleBody   f={f} />
      break
    case 'landmark':
      header = <LandmarkHeader f={f} />
      body   = <LandmarkBody   f={f} />
      break
    case 'traffic':
      header = <TrafficHeader f={f} />
      body   = <TrafficBody   f={f} />
      break
  }

  return (
    <div className={css.panel}>
      <div className={css.header}>
        {header}
        <button className={css.close} onClick={onClose} aria-label="Close">✕</button>
      </div>
      {body}
    </div>
  )
}
