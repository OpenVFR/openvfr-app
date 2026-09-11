import css from './AirspacePopup.module.css'
import { AIRSPACE_COLORS as AC } from '@open-vfr/shared/airspaceColors'
import { fmtNotamDate, type NotamItem } from '@open-vfr/shared/fetchNotam'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AirspaceFeature {
  class: string      // C | D | E | G | R | TRA | GLDR | MODEL
  type: string       // CTR | TMA | CTA | D | P | R | …  (OFMX codeType)
  name: string
  upper: string      // human-readable ceiling, e.g. "FL095", "UNL", "3000ft MSL"
  lower: string      // human-readable floor,   e.g. "SFC", "1500ft AGL"
  upper_ft: number
  lower_ft: number
  remarks?:     string
  frequencies?: { freq_mhz: number; callsign: string; service: string }[]
  /** Exterior ring of the polygon [[lng,lat]…] — full, untruncated shape
   *  (resolved via @open-vfr/shared/airspaceGeometryCache), used for the
   *  per-row shape thumbnail. */
  coords?: number[][]
  /** Active regional NOTAM(s) matched to this area by designator code --
   *  see useNotamAirspaceMatch.ts. Undefined/empty = no active NOTAM found
   *  (does NOT mean none exists -- only permanent charted areas can match;
   *  see that hook's own caveat about temporary areas). */
  notams?: NotamItem[]
}

type RowItem =
  | { kind: 'airspace'; feature: AirspaceFeature }
  | { kind: 'gap'; lowerFt: number; upperFt: number }

// ── Constants ─────────────────────────────────────────────────────────────────

/** upper_ft at or above this → treat as Unlimited. */
const UNL_THRESHOLD_FT = 60_000
/** Y-axis cap for the altitude diagram when UNL is present (FL200). */
const DIAGRAM_CAP_FT   = 20_000

// ── Label / colour maps ──────────────────────────────────────────────
// Sourced entirely from @open-vfr/shared/airspaceColors — the single
// canonical palette also used by the map (map-style.ts). A previous
// hand-copied approximation here didn't match what's actually drawn on
// the map (and, like the native theme.ts bug fixed earlier, collapsed the
// CTR-vs-TMA distinction to one colour). Never re-introduce a local copy.

/** Human-readable labels for OFMX codeType values. */
const TYPE_LABEL: Record<string, string> = {
  CTR:   'CTR',
  TMA:   'TMA',
  CTA:   'CTA',
  FIR:   'FIR',
  UIR:   'UIR',
  D:     'Danger',
  R:     'Restricted',
  P:     'Prohibited',
  TRA:   'TRA',
  GLDR:  'Glider',
  MODEL: 'Model',
  RMZ:   'RMZ',
  ATZ:   'ATZ',
  TMZ:   'TMZ',
}

const CLASS_LABEL: Record<string, string> = {
  C:     'Class C',
  D:     'Danger',
  E:     'Class E',
  G:     'Class G',
  R:     'Restricted',
  TRA:   'TRA',
  GLDR:  'Activity',
  MODEL: 'Activity',
}

/** Re-express an rgba()/rgb() colour string with a different alpha — used for
 *  translucent fills/backgrounds derived from the (now rgba-based) border
 *  colour. The old `${hex}22` suffix trick only worked with hex strings. */
function withAlpha(color: string, alpha: number): string {
  const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/)
  if (!m) return color
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`
}

function bandColor(cls: string, type?: string): string {
  if (cls === 'C') return type === 'CTR' ? AC.cCtrBorder : AC.cTmaBorder
  switch (cls) {
    case 'D':     return AC.dBorder
    case 'E':     return AC.eBorder
    case 'G':     return AC.gBorder
    case 'R':     return AC.rBorder
    case 'TRA':   return AC.traBorder
    case 'GLDR':  return AC.gldrBorder
    case 'MODEL': return AC.modelBorder
    default:      return AC.gBorder
  }
}

// ── Altitude diagram helpers ──────────────────────────────────────────────────

function diagramMaxFt(features: AirspaceFeature[]): number {
  const raw = Math.max(...features.map((f) => f.upper_ft))
  return raw >= UNL_THRESHOLD_FT ? DIAGRAM_CAP_FT : raw
}

/**
 * Maps an altitude in feet to a Y coordinate in a viewBox with height 100.
 * Y = 0   → top of SVG    = maximum altitude
 * Y = 100 → bottom of SVG = SFC (0 ft)
 */
function svgY(ft: number, maxFt: number): number {
  return 100 - (Math.min(ft, maxFt) / maxFt) * 100
}

// ── Polygon shape thumbnail ──────────────────────────────────────────────
// Same math as native's AirspacePopup.tsx PolygonThumb/coordsToPath — shows
// each zone's actual geographic outline, not just its altitude band. Ported
// here (not moved to shared) since it produces markup for two different
// rendering targets (DOM <svg> vs react-native-svg <Svg>/<Path>).
const THUMB_VB   = 100   // viewBox size
const THUMB_MARG =   8   // margin inside viewBox

function coordsToPath(ring: number[][]): string {
  if (!ring || ring.length < 3) return ''

  // Mercator-like longitude correction for the polygon's latitude so the
  // thumbnail aspect ratio matches what's drawn on the map.
  let sumLat = 0
  for (const [, lat] of ring) sumLat += lat
  const cosLat = Math.cos((sumLat / ring.length) * Math.PI / 180)

  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  for (const [lng, lat] of ring) {
    const x = lng * cosLat
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (lat < minY) minY = lat; if (lat > maxY) maxY = lat
  }
  const rX = maxX - minX || 1
  const rY = maxY - minY || 1
  const use = THUMB_VB - 2 * THUMB_MARG

  // Uniform scale — preserve aspect ratio (same as map projection)
  const scale = Math.min(use / rX, use / rY)
  const drawW = rX * scale
  const drawH = rY * scale
  const offX  = THUMB_MARG + (use - drawW) / 2
  const offY  = THUMB_MARG + (use - drawH) / 2

  const pts = ring.map(([lng, lat]) => {
    const x  = lng * cosLat
    const sx = offX + ((x   - minX) / rX) * drawW
    const sy = offY + ((maxY - lat)  / rY) * drawH  // flip Y: lat↑ → SVG y↓
    return `${sx.toFixed(2)},${sy.toFixed(2)}`
  })
  return `M${pts.join('L')}Z`
}

function PolygonThumb({ coords, strokeColor, fillColor }: {
  coords?:     number[][]
  strokeColor: string
  fillColor:   string
}) {
  const d = coords ? coordsToPath(coords) : ''
  return (
    <svg className={css.polyThumb} viewBox={`0 0 ${THUMB_VB} ${THUMB_VB}`} aria-hidden="true">
      {d ? (
        <path d={d} fill={fillColor} stroke={strokeColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      ) : (
        <rect x={THUMB_MARG} y={THUMB_MARG} width={THUMB_VB - 2 * THUMB_MARG} height={THUMB_VB - 2 * THUMB_MARG}
          fill={fillColor} stroke={strokeColor} strokeWidth={1.5} />
      )}
    </svg>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  features: AirspaceFeature[]
  onClose: () => void
}

export default function AirspacePopup({ features, onClose }: Props) {
  // Deduplicate (same polygon may render from multiple tile edges) then sort
  // ceiling-first so the list reads top-down = high → low altitude.
  const seen = new Set<string>()
  const sorted = features
    .filter((f) => {
      const key = `${f.name}|${f.lower_ft}|${f.upper_ft}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => b.upper_ft - a.upper_ft)

  // Insert gap markers where uncontrolled airspace exists between adjacent layers.
  const items: RowItem[] = []
  sorted.forEach((f, i) => {
    items.push({ kind: 'airspace', feature: f })
    if (i < sorted.length - 1) {
      const next = sorted[i + 1]
      if (f.lower_ft > next.upper_ft + 100) {
        items.push({ kind: 'gap', lowerFt: next.upper_ft, upperFt: f.lower_ft })
      }
    }
  })

  const maxFt  = diagramMaxFt(sorted)
  const hasUnl = sorted.some((f) => f.upper_ft >= UNL_THRESHOLD_FT)

  return (
    <div className={css.panel}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className={css.header}>
        <span className={css.title}>
          Airspace
          {sorted.length > 1 && (
            <span className={css.count}>{sorted.length} layers</span>
          )}
        </span>
        <button className={css.close} onClick={onClose} aria-label="Close">✕</button>
      </div>

      {/* ── Body: altitude strip + rows ────────────────────────────────── */}
      <div className={css.body}>

        {/* Proportional vertical altitude diagram */}
        <div className={css.stripWrap}>
          <span className={css.stripLabel}>
            {hasUnl ? 'UNL' : (sorted[0]?.upper ?? '')}
          </span>
          <svg
            className={css.strip}
            viewBox="0 0 12 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {/* Background rail */}
            <rect x="4" y="0" width="4" height="100" fill="rgba(255,255,255,0.07)" rx="1.5" />
            {/* Airspace bands */}
            {sorted.map((f, i) => {
              const topY = svgY(f.upper_ft, maxFt)
              const botY = svgY(f.lower_ft, maxFt)
              return (
                <rect
                  key={i}
                  x="4"
                  y={topY}
                  width="4"
                  height={Math.max(botY - topY, 1.5)}
                  fill={bandColor(f.class, f.type)}
                  opacity="0.9"
                />
              )
            })}
            {/* SFC tick */}
            <line x1="2" y1="100" x2="10" y2="100" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
          </svg>
          <span className={css.stripLabel}>SFC</span>
        </div>

        {/* Airspace rows + gap markers */}
        <div className={css.rows}>
          {items.map((item, i) => {
            if (item.kind === 'gap') {
              const lo = item.lowerFt === 0 ? 'SFC' : `${item.lowerFt}ft`
              const hi = `${item.upperFt}ft`
              return (
                <div key={i} className={css.gapRow}>
                  <span className={css.gapLabel}>uncontrolled · {lo} – {hi}</span>
                </div>
              )
            }

            const f        = item.feature
            const c        = bandColor(f.class, f.type)
            const typeText = TYPE_LABEL[f.type] ?? f.type ?? f.class
            const isUnl    = f.upper_ft >= UNL_THRESHOLD_FT

            return (
              <div key={i} className={css.row}>
              <div className={css.rowInner}>
                <PolygonThumb coords={f.coords} strokeColor={c} fillColor={withAlpha(c, 0.13)} />
                <div className={css.rowContent}>
                {/* Type tag + class badge */}
                <div className={css.bandTop}>
                  <span className={css.typeTag}>{typeText}</span>
                  <span
                    className={css.classBadge}
                    style={{ color: c, background: withAlpha(c, 0.13), borderColor: withAlpha(c, 0.33) }}
                  >
                    {CLASS_LABEL[f.class] ?? f.class}
                  </span>
                </div>

                {/* Name */}
                <div className={css.name}>{f.name}</div>

                {/* Compact floor – ceiling on one line */}
                <div className={css.altBand}>
                  <span className={css.altVal}>{f.lower}</span>
                  <span className={css.altSep}>–</span>
                  <span className={css.altVal}>{isUnl ? 'UNL' : f.upper}</span>
                </div>

                {/* Frequencies */}
                {f.frequencies && f.frequencies.length > 0 && (
                  <div className={css.freqList}>
                    {f.frequencies.map((fr, fi) => (
                      <span key={fi} className={css.freqItem}>
                        <b>{fr.freq_mhz.toFixed(3)}</b>
                        {fr.callsign ? ` ${fr.callsign}` : ''}
                      </span>
                    ))}
                  </div>
                )}
                {!f.frequencies && f.class === 'G' && (
                  <div className={css.fisHint}>
                    FIS frequency — see nearest aerodrome or AIP ENR 2.2
                  </div>
                )}

                {/* Active NOTAM(s), matched by designator code */}
                {f.notams && f.notams.length > 0 && (
                  <div className={css.remarks} style={{ borderColor: '#e64980', background: 'rgba(230,73,128,0.1)' }}>
                    {f.notams.map((n, ni) => (
                      <div key={ni} style={{ marginBottom: ni < f.notams!.length - 1 ? 6 : 0 }}>
                        <strong>NOTAM {n.id}</strong>
                        {n.effective && <span> · {fmtNotamDate(n.effective)}</span>}
                        {n.expires && <span> – {fmtNotamDate(n.expires)}</span>}
                        <div style={{ whiteSpace: 'pre-line' }}>{n.text}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Remarks */}
                {f.remarks && (
                  <div className={css.remarks}>{f.remarks}</div>
                )}
                </div>
              </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Footer disclaimer ──────────────────────────────────────────── */}
      <div className={css.footer}>
        ⚠ Static AIRAC data — verify activation via NOTAMs
      </div>
    </div>
  )
}
