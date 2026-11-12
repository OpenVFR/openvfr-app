import type React from 'react'
import css from './FeaturePopup.module.css'
import { TRAFFIC_CATEGORY_LABEL, trafficDeviceLabel, trafficNetworkLabel } from '@open-vfr/shared/trafficState'
import { IconX } from '@tabler/icons-react'
import { orbitLabel, type LocalAreaInfo } from '@open-vfr/shared/aerodromeDetails'
import { useLocalInfo } from '../utils/aerodromeDetails'
import { EXPERIMENTAL_AERODROME_DETAILS } from '../utils/env'

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
  source:   'opensky' | 'ogn'
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

/** A noise-sensitive area, circuit line or other local area of an aerodrome (aerodrome-details layers). */
export interface LocalAreaFeature extends LocalAreaInfo {
  kind: 'localArea'
  /** Airspace over the tapped point (an area is usually inside a CTR/TMA): shown under the area so it is not lost. */
  airspace?: { class: string; name: string; lower: string; upper: string }[]
}

export type PointFeature =
  | NavaidFeature
  | WaypointFeature
  | ObstacleFeature
  | LandmarkFeature
  | TrafficFeature
  | RegionalNotamFeature
  | LocalAreaFeature

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
      {EXPERIMENTAL_AERODROME_DETAILS && f.aerodrome && /^HOLDING\s/i.test(f.name) && (
        <HoldingRows aerodrome={f.aerodrome} name={f.name.replace(/^HOLDING\s+/i, '').toUpperCase()} />
      )}
    </div>
  )
}

/** Orbit direction and where to hold, from the aerodrome's local information (experimental). */
function HoldingRows({ aerodrome, name }: { aerodrome: string; name: string }) {
  const info = useLocalInfo(aerodrome, true)
  const h = info?.holdings.find(x => x.name.toUpperCase() === name)
  if (!h) return null
  const pending = info?.provenance['holdings']?.review === 'pending'
  return (
    <>
      {h.direction && (
        <div className={css.row}>
          <span className={css.label}>Orbit</span>
          <span className={css.value}>{orbitLabel(h.direction)}{pending ? ' (unreviewed)' : ''}</span>
        </div>
      )}
      {h.description && (
        <div className={css.row}>
          <span className={css.label}>Hold</span>
          <span className={css.value}>{h.description}</span>
        </div>
      )}
    </>
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


function TrafficHeader({ f }: { f: TrafficFeature }) {
  return (
    <div className={css.headerContent}>
      <span className={css.bigId}>{f.callsign ?? f.icao24}</span>
      {f.callsign && <span className={css.typeTag}>{f.icao24.toUpperCase()}</span>}
      <span className={css.typeTag}>{trafficDeviceLabel(f.icao24)}</span>
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
          <span className={css.value}>{TRAFFIC_CATEGORY_LABEL[f.category] ?? `Cat ${f.category}`}</span>
        </div>
      )}
      <div className={css.source}>© {trafficNetworkLabel(f.source)}</div>
    </div>
  )
}

function LocalAreaHeader({ f }: { f: LocalAreaFeature }) {
  return (
    <div className={css.headerContent}>
      <span className={css.typeTag}>{f.kindLabel}</span>
    </div>
  )
}

function LocalAreaBody({ f }: { f: LocalAreaFeature }) {
  return (
    <div className={css.body}>
      {f.name && <div className={css.name}>{f.name}</div>}
      {f.note && <div className={css.row}><span className={css.value}>{f.note}</span></div>}
      {f.limits && !f.below && (
        <div className={css.row}>
          <span className={css.label}>Limits</span>
          <span className={css.value}>{f.limits}</span>
        </div>
      )}
      <div className={css.row}>
        <span className={css.label}>Aerodrome</span>
        <span className={css.value}>{f.aerodrome}</span>
      </div>
      {f.approximate && (
        <div className={css.row}>
          <span className={css.label}>Outline</span>
          <span className={css.value}>Approximate{f.accuracyM ? `, about ±${f.accuracyM} m` : ''}: drawn from a map, not surveyed</span>
        </div>
      )}
      {f.pending && <div className={css.row}><span className={css.value}>Unreviewed</span></div>}
      {f.airspace && f.airspace.length > 0 && (
        <div className={css.row}>
          <span className={css.label}>Airspace here</span>
          <span className={css.value}>{f.airspace.map(a => `${a.class} ${a.name} ${a.lower}–${a.upper}`).join(' · ')}</span>
        </div>
      )}
      {f.source && <div className={css.source}>Source: {f.source}</div>}
    </div>
  )
}

// (former RegionalNotamHeader/RegionalNotamBody removed -- see PointFeature comment above)

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  feature: PointFeature
  onClose: () => void
  /** Route button (navaids, reporting points): "Start route here", "Add to route", "Direct to"... */
  routeAction?: { label: string; onClick: () => void }
}

export default function FeaturePopup({ feature: f, onClose, routeAction }: Props) {
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
    case 'localArea':
      header = <LocalAreaHeader f={f} />
      body   = <LocalAreaBody   f={f} />
      break
  }

  return (
    <div className={css.panel}>
      <div className={css.header}>
        {header}
        {routeAction && (
          <button className={css.routeBtn} onClick={routeAction.onClick}>{routeAction.label}</button>
        )}
        <button className={css.close} onClick={onClose} aria-label="Close"><IconX size={14} aria-hidden="true" /></button>
      </div>
      {body}
    </div>
  )
}
