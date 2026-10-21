/**
 * MapCompass — map orientation control at the bottom right, above the scale
 * pill (same as native's CompassButton). Replaces MapLibre's compass and the
 * old toolbar orientation button.
 *
 * - Needle shows where north is.
 * - Shown while the map is rotated, or while flying (blue border = Track/Course
 *   Up, with a T / C badge).
 * - Flying: tap cycles North Up → Track Up → Course Up (when a route leg
 *   exists) → North Up. A north-up map the pilot turned by hand just re-aligns.
 * - On the ground, rotated: tap re-aligns to north.
 */
import { useEffect, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import type { MapOrientation } from '../utils/gpsTypes'
import css from './MapCompass.module.css'

const ROTATED_DEG = 1

export default function MapCompass({ map, orientation, canToggle, canCourse, onOrientationChange }: {
  map: maplibregl.Map | null
  orientation: MapOrientation
  /** Orientation can be changed (flying). */
  canToggle: boolean
  /** A route leg exists, so Course Up is available. */
  canCourse: boolean
  onOrientationChange: (o: MapOrientation) => void
}) {
  const [bearing, setBearing] = useState(0)
  useEffect(() => {
    if (!map) return
    const sync = () => setBearing(map.getBearing())
    sync()
    map.on('rotate', sync)
    return () => { map.off('rotate', sync) }
  }, [map])

  const norm = ((bearing % 360) + 540) % 360 - 180   // -180..180, 0 = north up
  const rotated = Math.abs(norm) > ROTATED_DEG
  if (!map || (!rotated && !canToggle)) return null

  const trackUp = orientation !== 'north'
  const cycles = canToggle && (trackUp || !rotated)
  const label = !cycles ? 'Map is rotated. Click for north up'
    : orientation === 'north' ? 'North up. Click for track up'
    : orientation === 'track' ? (canCourse ? 'Track up. Click for course up' : 'Track up. Click for north up')
    : 'Course up. Click for north up'

  const toNorth = () => { onOrientationChange('north'); map.easeTo({ bearing: 0, duration: 400 }) }
  const onClick = () => {
    if (!cycles) return toNorth()
    if (orientation === 'north') onOrientationChange('track')
    else if (orientation === 'track' && canCourse) onOrientationChange('course')
    else toNorth()
  }

  return (
    <button
      type="button"
      className={`${css.btn} ${trackUp ? css.active : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      data-testid="map-compass"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" style={{ transform: `rotate(${-bearing}deg)` }} aria-hidden>
        <path d="M12 2 L17.5 13 H6.5 Z" fill="#ef4444" />
        <path d="M12 22 L6.5 13 H17.5 Z" fill="var(--text-primary)" opacity="0.85" />
      </svg>
      {trackUp && <span className={css.badge}>{orientation === 'course' ? 'C' : 'T'}</span>}
    </button>
  )
}
