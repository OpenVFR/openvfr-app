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
    if (tokens[i]!.includes('.')) return null
  }

  if (tokens.length === 1) {
    const intPart = tokens[0]!.split('.')[0]!
    // Degrees never need 4+ integer digits, so that's the compact form.
    if (intPart.length >= 4) return parseCompact(tokens[0]!, maxDeg)
    const v = parseFloat(tokens[0]!)
    return v <= maxDeg ? { value: v, style: 'DD' } : null
  }

  const deg = parseInt(tokens[0]!, 10)
  const min = parseFloat(tokens[1]!)
  const sec = tokens.length === 3 ? parseFloat(tokens[2]!) : 0
  if (min >= 60 || sec >= 60) return null
  const value = deg + min / 60 + sec / 3600
  if (value > maxDeg) return null
  return { value, style: tokens.length === 2 ? 'DDM' : 'DMS' }
}

/** DDMM[.m] / DDMMSS[.s] (lat) or DDDMM[.m] / DDDMMSS[.s] (lon). */
function parseCompact(token: string, maxDeg: number): AxisValue | null {
  const degDigits = maxDeg === 90 ? 2 : 3
  const [intPartRaw, frac] = token.split('.')
  const intPart = intPartRaw!
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

  const a = letterIdx[0]!, b = letterIdx[1]!
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

  const l1 = tokens[a]!
  const l2 = tokens[b]!
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
    const g0 = g[0]!
    const neg = g0.startsWith('-')
    const toks = [neg ? g0.slice(1) : g0, ...g.slice(1)]
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

// ---------------------------------------------------------------------------
// Scanning free text for coordinates (NOTAM text, notes, search blobs)
// ---------------------------------------------------------------------------

/** One latitude/longitude pair found inside a longer text. */
export interface FoundCoordinate {
  lat: number
  lng: number
  /** Offsets into the scanned string: `text.slice(start, end)` is the match. */
  start: number
  end: number
  format: CoordFormat
}

const FRAC = String.raw`(?:[.,]\d+)?`
// Seconds / minutes field: two digits, optional decimals ("22", "07.38", "22,5").
const F2 = String.raw`\d{1,2}${FRAC}`
const MARK_DEG = String.raw`\s*[°º˚]\s*`
const SEC_MARK = String.raw`(?:["″”]|''|′′|’’)?`

/** Degree-mark axis: 59°39'22" | 59°07.38' | 59° 07.38. Groups: d, m, s. */
const axisMarks = (degW: number) =>
  String.raw`(\d{1,${degW}})${MARK_DEG}(${F2})\s*(?:['′’]\s*(?:(${F2})\s*${SEC_MARK})?)?`
/** Whitespace-separated axis: 59 39 22 | 59 07.38. Groups: d, m, s. */
const axisSpaced = (degW: number) =>
  String.raw`(\d{${degW}})\s+(\d{2}${FRAC})(?:\s+(\d{2}${FRAC}))?`

// Every pattern captures either [d,m,s,hemi,d,m,s,hemi] (trailing letters) or
// [hemi,d,m,s,hemi,d,m,s] (leading letters). Compact patterns capture
// [digits,frac,hemi,digits,frac,hemi] / [hemi,digits,frac,hemi,digits,frac].
//
// The trailing compact pattern also accepts a longitude hemisphere typed "N"
// (seen in live data: "0205330N"), read as E; word boundaries keep it from
// swallowing the next token.
const NOT_BEFORE = String.raw`(?<![\dA-Z])(?<!\d[.,])`
const AFTER = String.raw`(?![\dA-Z])`
const SCAN: { re: RegExp; kind: 'compact-trail' | 'compact-lead' | 'dms-trail' | 'dms-lead'; style: CoordStyle }[] = [
  { kind: 'compact-trail', style: 'COMPACT',
    re: new RegExp(String.raw`(?<!\d)(?<!\d[.,])(\d{4}|\d{6})(${FRAC})\s*([NS])\s*(\d{4,7})(${FRAC})\s*([EWN])${AFTER}`, 'g') },
  { kind: 'compact-lead', style: 'COMPACT',
    re: new RegExp(String.raw`${NOT_BEFORE}([NS])\s*(\d{4}|\d{6})(${FRAC})\s*[,;]?\s*([EW])\s*(\d{4,7})(${FRAC})(?![\d])`, 'g') },
  { kind: 'dms-trail', style: 'DMS',
    re: new RegExp(String.raw`(?<!\d)(?<!\d[.,])${axisMarks(2)}\s*([NS])[\s,;]*${axisMarks(3)}\s*([EW])${AFTER}`, 'g') },
  { kind: 'dms-lead', style: 'DMS',
    re: new RegExp(String.raw`${NOT_BEFORE}([NS])\s*${axisMarks(2)}[\s,;]*([EW])\s*${axisMarks(3)}`, 'g') },
  { kind: 'dms-trail', style: 'DMS',
    re: new RegExp(String.raw`(?<!\d)(?<!\d[.,])${axisSpaced(2)}\s*([NS])[\s,;]*${axisSpaced(3)}\s*([EW])${AFTER}`, 'g') },
  { kind: 'dms-lead', style: 'DMS',
    re: new RegExp(String.raw`${NOT_BEFORE}([NS])\s*${axisSpaced(2)}[\s,;]*([EW])\s*${axisSpaced(3)}(?![\d])`, 'g') },
]

const num = (s: string | undefined): number => (s ? Number(s.replace(',', '.')) : 0)

/** DDMM[SS] / DDDMM[SS] digits (+ decimals on the last field) -> degrees, or null. */
function compactAxis(digits: string, frac: string, isLat: boolean): { v: number; sec: boolean } | null {
  const degW = isLat ? 2 : 3
  // A longitude with its leading zero missing ("175612E") has one digit less.
  let d = digits
  if (!isLat && (d.length === 4 || d.length === 6)) d = '0' + d
  const rest = d.length - degW
  if (rest !== 2 && rest !== 4) return null
  const deg = Number(d.slice(0, degW))
  const min = Number(d.slice(degW, degW + 2) + (rest === 2 ? frac.replace(',', '.') : ''))
  const sec = rest === 4 ? Number(d.slice(degW + 2) + frac.replace(',', '.')) : 0
  if (min >= 60 || sec >= 60) return null
  const v = deg + min / 60 + sec / 3600
  return v <= (isLat ? 90 : 180) ? { v, sec: rest === 4 } : null
}

function dmsAxis(d: string, m: string, s: string | undefined, isLat: boolean): number | null {
  const min = num(m), sec = num(s)
  if (min >= 60 || sec >= 60) return null
  if (s && /[.,]/.test(m)) return null // decimal minutes AND seconds
  const v = Number(d) + min / 60 + sec / 3600
  return v <= (isLat ? 90 : 180) ? v : null
}

/**
 * Every latitude/longitude pair in `text`, in order, with offsets.
 *
 * Notations: compact DDMM[SS][.d] (hemisphere letter before or after, decimal
 * point or comma, longitude missing its leading zero), degree-mark DMS /
 * decimal minutes, and whitespace-separated DMS. Matches need word
 * boundaries (no digit or letter glued to either end) and minutes/seconds
 * below 60: a bad coordinate is skipped on its own, never all-or-nothing.
 * Case-insensitive; offsets refer to the string as given.
 */
export function findCoordinates(text: string): FoundCoordinate[] {
  const src = text.toUpperCase() // same length for ASCII/NOTAM text
  const cands: FoundCoordinate[] = []
  for (const { re, kind, style } of SCAN) {
    for (const m of src.matchAll(re)) {
      let lat: number | null, lng: number | null, latL: string, lngL: string
      let sec = false
      if (kind === 'compact-trail' || kind === 'compact-lead') {
        const [a, af, al, b, bf, bl] = kind === 'compact-trail'
          ? [m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!] : [m[2]!, m[3]!, m[1]!, m[5]!, m[6]!, m[4]!]
        const la = compactAxis(a, af, true), lo = compactAxis(b, bf, false)
        lat = la ? la.v : null; lng = lo ? lo.v : null
        sec = !!la?.sec
        latL = al; lngL = bl
      } else if (kind === 'dms-trail') {
        lat = dmsAxis(m[1]!, m[2]!, m[3], true); lng = dmsAxis(m[5]!, m[6]!, m[7], false)
        latL = m[4]!; lngL = m[8]!
      } else {
        lat = dmsAxis(m[2]!, m[3]!, m[4], true); lng = dmsAxis(m[6]!, m[7]!, m[8], false)
        latL = m[1]!; lngL = m[5]!
      }
      if (lat === null || lng === null) continue
      cands.push({
        lat: latL === 'S' ? -lat : lat,
        lng: lngL === 'W' ? -lng : lng,
        start: m.index!, end: m.index! + m[0].length,
        format: {
          style, lngFirst: false,
          hemi: kind.endsWith('lead') ? 'leading' : 'trailing',
          ...(style === 'COMPACT' ? { compactSeconds: sec } : {}),
        },
      })
    }
  }
  // Earliest first, longest wins on a tie; overlapping candidates are dropped.
  cands.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: FoundCoordinate[] = []
  for (const c of cands) {
    const last = out[out.length - 1]
    if (!last || c.start >= last.end) out.push(c)
  }
  return out
}
