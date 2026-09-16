/**
 * TafTimeline — hour-by-hour decoded TAF table.
 *
 * Visual parity target: public METAR/TAF sites present a TAF as a
 * horizontally-scrolling per-hour table (flight-rule pill / sky icon+label /
 * visibility / ceiling / wind arrow+speed) rather than raw period groups.
 * This slices the already-parsed TafPeriod[] (buildTafTimeline, resolved the
 * same way the chart's "current instant" TAF resolution works) into hourly
 * columns and renders that table. Complements, doesn't replace, the raw TAF
 * text and the FM/BECMG/TEMPO period cards shown alongside it.
 */

import { buildTafTimeline, type TafPeriod } from '@open-vfr/shared/parseTaf'
import { sunriseSunset } from '@open-vfr/shared/sunCalc'
import { fmtVis, fmtWind, visTone, ceilingTone, windTone, skyLabel } from '@open-vfr/shared/wxFormat'
import css from './TafTimeline.module.css'

interface Props {
  periods: TafPeriod[] | null
  /** Aerodrome position -- used only to pick a sun vs. moon sky icon per hour. */
  lat: number
  lng: number
  maxHours?: number
}

function isDaytimeAt(lat: number, lng: number, atMs: number): boolean {
  const { rise, set } = sunriseSunset(lat, lng, new Date(atMs))
  if (!rise || !set) return true // polar day, or calc failed -- default to sun icon rather than guessing night
  return atMs >= rise.getTime() && atMs <= set.getTime()
}

function SkyIcon({ cover, daytime }: { cover: 'CLR' | 'FEW' | 'SCT' | 'BKN' | 'OVC'; daytime: boolean }) {
  const showCelestial = cover === 'CLR' || cover === 'FEW' || cover === 'SCT'
  const showCloud = cover !== 'CLR'
  return (
    <svg viewBox="0 0 24 24" className={css.skyIcon}>
      {showCelestial && daytime && (
        <g className={css.sun}>
          <circle cx="12" cy="10" r="4" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <line
              key={a}
              x1="12" y1="10" x2="12" y2="4"
              transform={`rotate(${a} 12 10)`}
            />
          ))}
        </g>
      )}
      {showCelestial && !daytime && (
        <path className={css.moon} d="M14 5 A6 6 0 1 0 14 17 A5 5 0 0 1 14 5 Z" />
      )}
      {showCloud && (
        <path
          className={css.cloud}
          d="M6 18 a3.5 3.5 0 0 1 0.3 -6.98 A4.5 4.5 0 0 1 15 10.2 A3.2 3.2 0 0 1 18 18 Z"
        />
      )}
    </svg>
  )
}

function coverForCeiling(ceilingFt: number | null, hasAnyClouds: boolean): 'CLR' | 'FEW' | 'SCT' | 'BKN' | 'OVC' {
  if (ceilingFt == null) return hasAnyClouds ? 'SCT' : 'CLR'
  if (ceilingFt < 1500) return 'OVC'
  return 'BKN'
}

function fmtColTime(atMs: number): { day: string; time: string } {
  const d = new Date(atMs)
  const day = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:00Z`
  return { day, time }
}

export default function TafTimeline({ periods, lat, lng, maxHours = 24 }: Props) {
  const slices = buildTafTimeline(periods, { stepHours: 1, maxSlices: maxHours })
  if (slices.length === 0) return null

  return (
    <div className={css.scrollWrap}>
      <table className={css.table}>
        <tbody>
          <tr>
            <th className={css.rowLabel}>Time (UTC)</th>
            {slices.map((s) => {
              const { day, time } = fmtColTime(s.atMs)
              return (
                <td key={s.atMs} className={css.timeCell}>
                  <div className={css.timeDay}>{day}</div>
                  <div className={css.timeHour}>{time}</div>
                </td>
              )
            })}
          </tr>
          <tr>
            <th className={css.rowLabel}>Rule</th>
            {slices.map((s) => (
              <td key={s.atMs} className={css.cell}>
                <span className={`${css.frPill} ${css[`fr${s.flightRule}`]}`}>{s.flightRule}</span>
              </td>
            ))}
          </tr>
          <tr>
            <th className={css.rowLabel}>Sky</th>
            {slices.map((s) => (
              <td key={s.atMs} className={css.cell}>
                <SkyIcon cover={coverForCeiling(s.ceilingFt, s.clouds.length > 0)} daytime={isDaytimeAt(lat, lng, s.atMs)} />
                <div className={css.skyLabel}>{skyLabel(s.clouds)}</div>
              </td>
            ))}
          </tr>
          <tr>
            <th className={css.rowLabel}>Vis</th>
            {slices.map((s) => (
              <td key={s.atMs} className={`${css.cell} ${css[`tone${visTone(s.visM)}`]}`}>{fmtVis(s.visM)}</td>
            ))}
          </tr>
          <tr>
            <th className={css.rowLabel}>Ceiling</th>
            {slices.map((s) => (
              <td key={s.atMs} className={`${css.cell} ${css[`tone${ceilingTone(s.ceilingFt)}`]}`}>
                {s.ceilingFt != null ? `${s.ceilingFt.toLocaleString()} ft` : '—'}
              </td>
            ))}
          </tr>
          <tr>
            <th className={css.rowLabel}>Wind</th>
            {slices.map((s) => (
              <td key={s.atMs} className={`${css.cell} ${css[`tone${windTone(s.wind)}`]}`}>
                {s.wind && !s.wind.calm && !s.wind.variable && s.wind.dirDeg != null && (
                  <svg viewBox="0 0 24 24" className={css.windArrow} style={{ transform: `rotate(${s.wind.dirDeg + 180}deg)` }}>
                    <path d="M12 2 L18 14 L12 10.5 L6 14 Z" />
                  </svg>
                )}
                <div className={css.windText}>{fmtWind(s.wind)}</div>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}
