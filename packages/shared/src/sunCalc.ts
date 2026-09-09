/**
 * Sunrise / sunset calculator.
 *
 * Uses the NOAA simplified solar position algorithm (Spencer 1971 + corrections).
 * Accurate to ±1 minute for latitudes between −60° and +60° and within ±5 min
 * up to ±68° (adequate for Sweden: 55–69°N).
 *
 * Returns UTC times. No external dependencies — pure arithmetic.
 */

const DEG = Math.PI / 180

/**
 * Compute sunrise and sunset UTC times for a given position and calendar date.
 *
 * @param lat     Latitude (°N positive)
 * @param lng     Longitude (°E positive)
 * @param date    The calendar date to use (UTC date fields are used). Defaults to today.
 * @returns       `{ rise, set }` — either may be `null` for polar day/night.
 */
export function sunriseSunset(
  lat: number,
  lng: number,
  date: Date = new Date(),
): { rise: Date | null; set: Date | null } {
  // Day-of-year (1–366)
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0)
  const thisDay     = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  const doy         = (thisDay - startOfYear) / 86_400_000  // 1..366

  // Fractional year γ (radians)
  const g = (2 * Math.PI / 365) * (doy - 1 + 0.5 / 24)

  // Equation of time (minutes) — NOAA formula
  const eqTime =
    229.18 * (
      0.000075 +
      0.001868 * Math.cos(g)     - 0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) - 0.04089  * Math.sin(2 * g)
    )

  // Solar declination (radians) — NOAA formula
  const decl =
    0.006918 -
    0.399912 * Math.cos(g)     + 0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) + 0.001480 * Math.sin(3 * g)

  // Hour angle at sunrise/sunset.
  // Zenith = 90°50' (90.833°) accounts for atmospheric refraction + solar disc half-diameter.
  const cosHA =
    (Math.cos(90.833 * DEG) - Math.sin(lat * DEG) * Math.sin(decl)) /
    (Math.cos(lat * DEG) * Math.cos(decl))

  // Polar night or polar day
  if (cosHA > 1)  return { rise: null, set: null }
  if (cosHA < -1) return { rise: null, set: null }

  const ha = Math.acos(cosHA) / DEG  // hours-angle in degrees

  // Solar noon in UTC minutes = 720 − 4·lng − eqTime
  const solarNoonMin = 720 - 4 * lng - eqTime

  // Sunrise / sunset in UTC minutes
  const riseMin = solarNoonMin - 4 * ha
  const setMin  = solarNoonMin + 4 * ha

  function utcMinutesToDate(totalMinutes: number): Date {
    const d = new Date(date)
    d.setUTCHours(0, 0, 0, 0)
    d.setTime(d.getTime() + Math.round(totalMinutes) * 60_000)
    return d
  }

  return {
    rise: utcMinutesToDate(riseMin),
    set:  utcMinutesToDate(setMin),
  }
}

/** Format a UTC Date as "HH:MMz". Returns '—' if null. */
export function fmtSunTime(d: Date | null): string {
  if (!d) return '—'
  const h = d.getUTCHours().toString().padStart(2, '0')
  const m = d.getUTCMinutes().toString().padStart(2, '0')
  return `${h}:${m}z`
}
