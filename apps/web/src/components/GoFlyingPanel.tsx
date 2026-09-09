/**
 * GoFlyingPanel — in-flight instrument bar.
 *
 * Displayed at the bottom of the map canvas when flying mode is active.
 * Shows: mode badge, GS, TRK (true), ALT, next-waypoint info with
 * ETE/ETA tap-cycle, course correction indicator, and map-orientation buttons.
 */

import { useState } from 'react'
import type { GpsPosition, FlyingMode, MapOrientation } from '../utils/gpsTypes'
import { distanceNm, bearingDeg } from '../utils/routeCalc'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { NearestFeature } from '../hooks/useNearestFeature'
import type { WindAloft } from '@open-vfr/shared/fetchWind'
import { computeWindRelative } from '@open-vfr/shared/windRelative'
import css from './GoFlyingPanel.module.css'

type EteMode = 'ete-nxt' | 'eta-nxt' | 'ete-end' | 'eta-end'

interface Props {
  mode:         FlyingMode
  position:     GpsPosition
  wind?:        WindAloft | null
  /** The active destination waypoint (next turning point). Null = no route loaded. */
  nextWp:            RouteWaypoint | null
  /** All remaining waypoints from activeWpIdx to end of route (inclusive). */
  remainingWaypoints: RouteWaypoint[]
  orientation:       MapOrientation
  onOrientationChange: (o: MapOrientation) => void
  followAircraft:   boolean
  onFollow:         () => void
  onStop:           () => void
  positionReport:   NearestFeature | null
  onOpenDirectTo:   () => void
  onDropWaypoint:   () => void
  onTrackToggle:    () => void  // toggle lock/unlock of position report tracking
  isTracking:       boolean     // true = position report is locked to a specific point
  onOpenPlog:       () => void  // open / close the live pilot log panel
  plogOpen:         boolean
  onAdjustRoute:    () => void  // toggle in-flight route adjustment mode
  adjustMode:       boolean
}

function fmtHdg(deg: number): string {
  return Math.round(deg).toString().padStart(3, '0')
}

function fmtAlt(ft: number): string {
  if (ft >= 1000) return `${(ft / 1000).toFixed(1)}k`
  return Math.round(ft).toString()
}

function fmtDist(nm: number): string {
  if (nm >= 100) return `${nm.toFixed(0)} NM`
  if (nm >= 10)  return `${nm.toFixed(1)} NM`
  return `${nm.toFixed(2)} NM`
}

function fmtEte(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60)
    const m = Math.round(minutes % 60)
    return `${h}h ${m}m`
  }
  return `${Math.round(minutes)}m`
}

function fmtEta(minutesFromNow: number): string {
  const t = new Date(Date.now() + minutesFromNow * 60_000)
  return `${t.getUTCHours().toString().padStart(2,'0')}:${t.getUTCMinutes().toString().padStart(2,'0')}z`
}

export default function GoFlyingPanel({
  mode,
  position,
  wind,
  nextWp,
  remainingWaypoints,
  orientation,
  onOrientationChange,
  followAircraft,
  onFollow,
  onStop,
  positionReport,
  onOpenDirectTo,
  onDropWaypoint,
  onTrackToggle,
  isTracking,
  onOpenPlog,
  plogOpen,
  onAdjustRoute,
  adjustMode,
}: Props) {
  const [eteMode, setEteMode] = useState<EteMode>('ete-nxt')

  const pos = position

  // ── Next-WP calculations ──────────────────────────────────────────────────
  const distNxt = nextWp ? distanceNm(pos, nextWp) : null

  // Total distance from current position through remaining waypoints to end
  const distEnd: number | null = (() => {
    if (!nextWp || remainingWaypoints.length === 0) return null
    let total = distanceNm(pos, remainingWaypoints[0])
    for (let i = 0; i < remainingWaypoints.length - 1; i++) {
      total += distanceNm(remainingWaypoints[i], remainingWaypoints[i + 1])
    }
    return total
  })()

  const eteNxtMin = (distNxt !== null && pos.speedKts > 0.5) ? (distNxt / pos.speedKts) * 60 : null
  const eteEndMin = (distEnd !== null && pos.speedKts > 0.5) ? (distEnd / pos.speedKts) * 60 : null

  const ETE_CYCLE: EteMode[] = ['ete-nxt', 'eta-nxt', 'ete-end', 'eta-end']
  const cycleEte = () => {
    setEteMode(prev => ETE_CYCLE[(ETE_CYCLE.indexOf(prev) + 1) % ETE_CYCLE.length])
  }

  function eteLabel(): string {
    switch (eteMode) {
      case 'ete-nxt': return eteNxtMin !== null ? `ETE ${fmtEte(eteNxtMin)}`   : 'ETE —'
      case 'eta-nxt': return eteNxtMin !== null ? `ETA ${fmtEta(eteNxtMin)}`   : 'ETA —'
      case 'ete-end': return eteEndMin !== null ? `ETE▸ ${fmtEte(eteEndMin)}` : 'ETE▸ —'
      case 'eta-end': return eteEndMin !== null ? `ETA▸ ${fmtEta(eteEndMin)}` : 'ETA▸ —'
    }
  }

  // ── Wind decomposition ─────────────────────────────────────────────────────
  // Shared with native's GaugesBar.tsx — see windRelative.ts for the
  // head/tailwind math and the ±45° category cone (headwind=red,
  // tailwind=green, crosswind=yellow).
  const windRel = computeWindRelative(wind, pos.trackDeg, pos.speedKts)

  // ── Course-Correction Indicator ───────────────────────────────────────────
  // Bearing to next WP (true), then track error = degrees to turn.
  const bearingToNext = nextWp ? bearingDeg(pos, nextWp) : null
  const trackError    = bearingToNext !== null
    ? ((bearingToNext - pos.trackDeg + 540) % 360) - 180  // −180..+180
    : null

  function cciArrow(): string {
    if (trackError === null) return ''
    if (Math.abs(trackError) < 3) return '▲'  // on course
    return trackError > 0 ? '►' : '◄'
  }

  return (
    <div className={css.panel}>
      {/* ── Row 1: mode badge + instruments + orientation + stop ─────────── */}
      <div className={css.topRow}>

        {/* Mode badge */}
        <span className={`${css.badge} ${
          mode === 'gps' ? css.badgeGps
          : mode === 'ext' ? css.badgeExt
          : css.badgeSim
        }`}>
          {mode === 'gps' ? '● GPS' : mode === 'ext' ? '▶ EXT' : '▶ SIM'}
        </span>

        {/* Core instruments */}
        <div className={css.instruments}>

          <div className={css.cell}>
            <span className={css.cellLabel}>GS</span>
            <span className={css.cellValue}>
              {Math.round(pos.speedKts)}<span className={css.cellUnit}>kt</span>
            </span>
          </div>

          <div className={css.cell}>
            <span className={css.cellLabel}>TRK</span>
            <span className={css.cellValue}>
              {fmtHdg(pos.trackDeg)}<span className={css.cellUnit}>°</span>
            </span>
          </div>

          <div className={css.cell}>
            <span className={css.cellLabel}>ALT</span>
            <span className={`${css.cellValue} ${pos.altFt === 0 && mode === 'gps' ? css.dimmed : ''}`}>
              {fmtAlt(pos.altFt)}<span className={css.cellUnit}>ft</span>
            </span>
          </div>

          {/* Wind — always shown; "—" until API responds or when offline.
              Arrow rotates to show the direction the wind is blowing TOWARD
              relative to the nose (up=tailwind pushing you, down=headwind
              opposing you) — direction only, deliberately not colour-coded
              (headwind/tailwind isn't uniformly good/bad across flight
              phases — see windRelative.ts's doc comment). Colour instead
              reflects crosswind severity, the one component that's always
              unfavourable. */}
          <div className={css.cell}>
            <span className={css.cellLabel}>WND</span>
            <span className={`${css.cellValue} ${!wind ? css.dimmed : ''}`}>
              {windRel && (
                <span
                  className={css.windArrow}
                  style={{ transform: `rotate(${windRel.arrowRotationDeg}deg)` }}
                >▲</span>
              )}
              {wind
                ? `${Math.round(wind.dirDeg).toString().padStart(3, '0')}°/${Math.round(wind.speedKts)}`
                : '—'}
              <span className={css.cellUnit}>{wind ? 'kt' : ''}</span>
            </span>
          </div>

          {windRel && (
            <div className={css.cell}>
              <span className={css.cellLabel}>{windRel.hw >= 0 ? 'HW' : 'TW'}</span>
              <span className={css.cellValue}>
                {windRel.hw >= 0 ? '↑' : '↓'}{Math.abs(windRel.hw)}<span className={css.cellUnit}>kt</span>
              </span>
            </div>
          )}

          {windRel && (
            <div className={css.cell}>
              <span className={css.cellLabel}>XW</span>
              <span className={`${css.cellValue} ${css[`xw${windRel.crosswindSeverity === 'strong' ? 'Strong' : windRel.crosswindSeverity === 'moderate' ? 'Moderate' : 'Calm'}`]}`}>
                {windRel.xwRight ? '→' : '←'}{windRel.xw}<span className={css.cellUnit}>kt</span>
              </span>
            </div>
          )}

          {/* Radio freq — always shown; "—" while GeoJSON loads or when area has no freq data */}
          {(() => {
            const nearTwr = positionReport?.nearestTwrFreq &&
                            positionReport.nearestTwrDistNm != null &&
                            positionReport.nearestTwrDistNm <= 5
            const freq  = nearTwr
              ? positionReport!.nearestTwrFreq
              : (positionReport?.enrouteFreq ?? positionReport?.primaryFreq ?? null)
            const label = nearTwr
              ? (positionReport!.nearestTwrControlled ? 'TWR' : 'RADIO')
              : positionReport?.enrouteFreq ? 'INFO'
              : 'RADIO'
            return (
              <div className={css.cell}>
                <span className={css.cellLabel}>{label}</span>
                <span className={`${css.cellValue} ${freq ? css.radioFreq : css.dimmed}`}>
                  {freq ?? '—'}<span className={css.cellUnit}>{freq ? 'MHz' : ''}</span>
                </span>
              </div>
            )
          })()}

          {/* Course correction indicator */}
          {trackError !== null && (
            <div className={css.cci}>
              <span className={css.cciArrow}>{cciArrow()}</span>
              {Math.abs(trackError) >= 3 && (
                <span className={css.cciDeg}>{Math.round(Math.abs(trackError))}°</span>
              )}
            </div>
          )}
        </div>

        {/* Orientation + follow + stop */}
        <div className={css.controls}>
          <button
            className={`${css.orientBtn} ${css.orientBtnActive}`}
            onClick={() => onOrientationChange(orientation === 'north' ? 'track' : orientation === 'track' ? 'course' : 'north')}
            title={orientation === 'north' ? 'North Up — tap for Track Up' : orientation === 'track' ? 'Track Up — tap for Course Up' : 'Course Up — tap for North Up'}
          >
            {orientation === 'north' ? 'N↑' : orientation === 'track' ? 'TRK↑' : 'CRS↑'}
          </button>

          <button
            className={`${css.followBtn} ${followAircraft ? css.followBtnActive : css.followBtnOff}`}
            onClick={onFollow}
            title={followAircraft ? 'Following aircraft — tap to re-center' : 'Re-center on aircraft'}
          >
            {followAircraft ? '⊕' : '⊕ Re-center'}
          </button>

          <button className={css.directToBtn} onClick={onOpenDirectTo} title="Direct To aerodrome">
            D→
          </button>

          <button className={css.dropBtn} onClick={onDropWaypoint} title="Drop a waypoint here">
            📍
          </button>

          <button className={css.stopBtn} onClick={onStop}>
            ■ STOP
          </button>
        </div>
      </div>

      {/* ── Row 2: next WP info ───────────────────────────────────────────── */}
      <div className={css.wpRow}>
        <div className={css.wpSep} />

        {nextWp ? (
          <>
            <span className={css.wpArrow}>→</span>
            <span className={css.wpName}>{nextWp.name ?? 'WP'}</span>
            <span className={css.wpDist}>{distNxt !== null ? fmtDist(distNxt) : '—'}</span>
            <button className={css.eteToggle} onClick={cycleEte} title="Tap to cycle ETE / ETA">
              {eteLabel()}
            </button>
          </>
        ) : (
          <span className={css.wpNone}>No route — add waypoints to see distances</span>
        )}

        {mode === 'sim' && (
          <span className={css.simHint}>Arrows: turn/speed · +/−: altitude · Q: jump 1 NM · drag aircraft to teleport · tap map to navigate</span>
        )}
      </div>

      {/* ── Row 3: position report ────────────────────────────────────────── */}
      {positionReport && (
        <div className={css.posRow}>
          <span className={css.posKind}>
            {positionReport.kind === 'aerodrome' ? '✈' : positionReport.kind === 'navaid' ? '◉' : '◇'}
          </span>
          <span className={css.posName}>{positionReport.name}</span>
          <span className={css.posSep}>·</span>
          <span className={css.posBrg}>{Math.round(positionReport.bearingTrue).toString().padStart(3, '0')}°</span>
          <span className={css.posSep}>·</span>
          <span className={css.posDist}>
            {positionReport.distNm < 1
              ? `${(positionReport.distNm * 10).toFixed(1)}` /* sub-NM in tenths */
              : positionReport.distNm.toFixed(1)}
            {' NM'}
          </span>
          <button
            className={`${css.trackBtn} ${isTracking ? css.trackBtnActive : ''}`}
            onClick={onTrackToggle}
            title={isTracking ? 'Stop tracking — resume nearest feature' : 'Track this point'}
          >
            {isTracking ? '⊙' : '◎'}
          </button>
          <button
            className={`${css.plogBtn} ${plogOpen ? css.plogBtnActive : ''}`}
            onClick={onOpenPlog}
            title="Open pilot log"
          >
            PLOG
          </button>
          <button
            className={`${css.adjustBtn} ${adjustMode ? css.adjustBtnActive : ''}`}
            onClick={onAdjustRoute}
            title={adjustMode ? 'Lock route — exit adjustment mode' : 'Adjust route in flight'}
          >
            {adjustMode ? '🔓 ROUTE' : '✎ ROUTE'}
          </button>
        </div>
      )}
    </div>
  )
}
