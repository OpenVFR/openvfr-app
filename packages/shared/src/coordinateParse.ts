/**
 * Coordinate string parser for search inputs, shared by web + native.
 *
 * Accepts the formats pilots actually type or copy from charts/NOTAMs:
 *
 *   Decimal degrees (DD)   59.123 18.456 | 59.123,18.456 | -33.5 151.2
 *   Degrees-decimal-min    59 07.38N 018 27.36E | N59°07.38' E018°27.36'
 *   Degrees-min-sec (DMS)  59°07'22"N 18°27'21"E | 59 07 22 N 018 27 21 E
 *   Compact (NOTAM/AIP)    5939N01756E | 593922N0175612E | 5939.5N01756.2E
 *
 * Hemisphere letters may lead (N59 E18) or trail (59N 18E). When letters are
 * present the axis comes from the letter, so longitude-first input
 * (E018 N59) works too. Without letters the order is always lat, lon and the
 * sign gives the hemisphere.
 *
 * Returns the parsed position plus a `CoordFormat` describing how it was
 * typed, so `formatCoordinate()` can echo results back in the same style
 * instead of forcing decimal degrees on the user.
 */

export type CoordStyle = 'DD' | 'DDM' | 'DMS' | 'COMPACT'

export interface CoordFormat {
  style: CoordStyle
  /** Where hemisphere letters sat in the input; 'none' = signed numbers. */
  hemi: 'leading' | 'trailing' | 'none'
  /** Input gave longitude before latitude (only possible with letters). */
  lngFirst: boolean
  /** COMPACT only: input included seconds (DDMMSS) rather than DDMM. */
  compactSeconds?: boolean
}

export interface ParsedCoordinate {
  lat: number
  lng: number
  format: CoordFormat
}

interface AxisValue {
  value: number          // absolute degrees
  style: CoordStyle
  compactSeconds?: boolean
}

const NUM = /^\d+(?:\.\d+)?$/

/** Parse one axis group (tokens already stripped of hemisphere letter). */
function parseAxis(tokens: string[], maxDeg: number): AxisValue | null {
  if (tokens.length === 0 || tokens.length > 3) return null
  if (!tokens.every(t => NUM.test(t))) return null

  // Only the last component may carry a fractional part.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].includes('.')) return null
  }

  if (tokens.length === 1) {
    const intPart = tokens[0].split('.')[0]
    // Degrees never need 4+ integer digits, so that's the compact form.
    if (intPart.length >= 4) return parseCompact(tokens[0], maxDeg)
    const v = parseFloat(tokens[0])
    return v <= maxDeg ? { value: v, style: 'DD' } : null
  }

  const deg = parseInt(tokens[0], 10)
  const min = parseFloat(tokens[1])
  const sec = tokens.length === 3 ? parseFloat(tokens[2]) : 0
  if (min >= 60 || sec >= 60) return null
  const value = deg + min / 60 + sec / 3600
  if (value > maxDeg) return null
  return { value, style: tokens.length === 2 ? 'DDM' : 'DMS' }
}

/** DDMM[.m] / DDMMSS[.s] (lat) or DDDMM[.m] / DDDMMSS[.s] (lon). */
function parseCompact(token: string, maxDeg: number): AxisValue | null {
  const degDigits = maxDeg === 90 ? 2 : 3
  const [intPart, frac] = token.split('.')
  const rest = intPart.length - degDigits
  if (rest !== 2 && rest !== 4) return null
  const fracStr = frac ? `.${frac}` : ''
  const deg = parseInt(intPart.slice(0, degDigits), 10)
  let min: number
  let sec = 0
  if (rest === 2) {
    min = parseFloat(intPart.slice(degDigits) + fracStr)
  } else {
    min = parseInt(intPart.slice(degDigits, degDigits + 2), 10)
    sec = parseFloat(intPart.slice(degDigits + 2) + fracStr)
  }
  if (min >= 60 || sec >= 60) return null
  const value = deg + min / 60 + sec / 3600
  if (value > maxDeg) return null
  return { value, style: 'COMPACT', compactSeconds: rest === 4 }
}

function normalize(input: string): string {
  let s = input.trim().toUpperCase()
  // European decimal commas: "59,123 18,456" (exactly two comma-decimals).
  if (/^-?\d+,\d+\s+-?\d+,\d+$/.test(s)) s = s.replace(/,/g, '.')
  return s
    .replace(/[°º˚]/g, ' ')
    .replace(/''|["″”]/g, ' ')
    .replace(/['′’]/g, ' ')
    .replace(/[,;/]/g, ' ')
    // Separate letters from digits: "5939N01756E" -> "5939 N 01756 E"
    .replace(/([NSEW])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseCoordinate(input: string): ParsedCoordinate | null {
  const s = normalize(input)
  if (!s || !/^[\d.\sNSEW-]+$/.test(s)) return null
  const tokens = s.split(' ')
  const letterIdx = tokens.flatMap((t, i) => (/^[NSEW]$/.test(t) ? [i] : []))

  if (letterIdx.length === 0) return parseSigned(tokens)
  if (letterIdx.length !== 2) return null
  if (tokens.some(t => t.includes('-'))) return null // letters OR signs, not both

  const [a, b] = letterIdx
  let g1: string[]
  let g2: string[]
  let hemi: 'leading' | 'trailing'
  if (a === 0) {
    hemi = 'leading'
    g1 = tokens.slice(1, b)
    g2 = tokens.slice(b + 1)
  } else if (b === tokens.length - 1) {
    hemi = 'trailing'
    g1 = tokens.slice(0, a)
    g2 = tokens.slice(a + 1, b)
  } else {
    return null
  }

  const l1 = tokens[a]
  const l2 = tokens[b]
  const isLat = (l: string) => l === 'N' || l === 'S'
  if (isLat(l1) === isLat(l2)) return null

  const lngFirst = !isLat(l1)
  const [latTok, lngTok, latL, lngL] = lngFirst ? [g2, g1, l2, l1] : [g1, g2, l1, l2]
  const lat = parseAxis(latTok, 90)
  const lng = parseAxis(lngTok, 180)
  if (!lat || !lng || lat.style !== lng.style) return null

  return {
    lat: latL === 'S' ? -lat.value : lat.value,
    lng: lngL === 'W' ? -lng.value : lng.value,
    format: {
      style: lat.style,
      hemi,
      lngFirst,
      ...(lat.style === 'COMPACT' ? { compactSeconds: !!lat.compactSeconds } : {}),
    },
  }
}

/** No hemisphere letters: lat then lon, equal token counts, sign = hemisphere. */
function parseSigned(tokens: string[]): ParsedCoordinate | null {
  if (tokens.length % 2 !== 0) return null
  const half = tokens.length / 2
  const split = (g: string[]): { neg: boolean; toks: string[] } | null => {
    const neg = g[0].startsWith('-')
    const toks = [neg ? g[0].slice(1) : g[0], ...g.slice(1)]
    if (toks.some(t => t.includes('-'))) return null
    return { neg, toks }
  }
  const a = split(tokens.slice(0, half))
  const b = split(tokens.slice(half))
  if (!a || !b) return null
  const lat = parseAxis(a.toks, 90)
  const lng = parseAxis(b.toks, 180)
  // Compact needs letters to be unambiguous; reject it signed.
  if (!lat || !lng || lat.style !== lng.style || lat.style === 'COMPACT') return null
  return {
    lat: a.neg ? -lat.value : lat.value,
    lng: b.neg ? -lng.value : lng.value,
    format: { style: lat.style, hemi: 'none', lngFirst: false },
  }
}

// ---------------------------------------------------------------------------
// Formatting (echo a position back in the style the user typed)
// ---------------------------------------------------------------------------

const pad = (n: number, w: number) => String(n).padStart(w, '0')

/** Split |deg| into d/m(/s) with rounding carried upward (no "60.000'"). */
function dm(abs: number, minDecimals: number): [number, string] {
  const scale = 10 ** minDecimals
  const totalMin = Math.round(abs * 60 * scale) / scale
  const d = Math.floor(totalMin / 60 + 1e-9)
  const m = totalMin - d * 60
  const mStr = m.toFixed(minDecimals).padStart(minDecimals > 0 ? 3 + minDecimals : 2, '0')
  return [d, mStr]
}

function dms(abs: number, secDecimals: number): [number, number, string] {
  const scale = 10 ** secDecimals
  const totalSec = Math.round(abs * 3600 * scale) / scale
  const d = Math.floor(totalSec / 3600 + 1e-9)
  const m = Math.floor((totalSec - d * 3600) / 60 + 1e-9)
  const s = totalSec - d * 3600 - m * 60
  const sStr = s.toFixed(secDecimals).padStart(secDecimals > 0 ? 3 + secDecimals : 2, '0')
  return [d, m, sStr]
}

function formatAxis(value: number, isLat: boolean, f: CoordFormat): string {
  const abs = Math.abs(value)
  const letter = isLat ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E')
  const degW = isLat ? 2 : 3
  let body: string
  switch (f.style) {
    case 'DD':
      body = `${abs.toFixed(5)}°`
      break
    case 'DDM': {
      const [d, m] = dm(abs, 3)
      body = `${pad(d, degW)}° ${m}'`
      break
    }
    case 'DMS': {
      const [d, m, s] = dms(abs, 1)
      body = `${pad(d, degW)}° ${pad(m, 2)}' ${s}"`
      break
    }
    case 'COMPACT': {
      if (f.compactSeconds) {
        const [d, m, s] = dms(abs, 0)
        body = `${pad(d, degW)}${pad(m, 2)}${s}`
      } else {
        const [d, m] = dm(abs, 0)
        body = `${pad(d, degW)}${m}`
      }
      return f.hemi === 'leading' ? `${letter}${body}` : `${body}${letter}`
    }
  }
  if (f.hemi === 'none') return value < 0 ? `-${body}` : body
  return f.hemi === 'leading' ? `${letter}${body}` : `${body}${letter}`
}

export function formatCoordinate(lat: number, lng: number, f: CoordFormat): string {
  const la = formatAxis(lat, true, f)
  const lo = formatAxis(lng, false, f)
  const sep = f.style === 'COMPACT' ? '' : ' '
  return f.lngFirst ? `${lo}${sep}${la}` : `${la}${sep}${lo}`
}
