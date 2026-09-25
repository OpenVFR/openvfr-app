/**
 * AirspacePopup — accordion list of all airspace zones at the tapped point.
 * Sorted by lower_ft ascending (ground-level first).
 * Each row shows: polygon shape thumbnail, class-colour badges, altitude range.
 * Tap any row to expand for detail.
 */

import React, { useState } from 'react'
import {
  Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet,
} from 'react-native'
import Svg, { Path, Rect, Line } from 'react-native-svg'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import { AIRSPACE_COLORS as AC } from '@open-vfr/shared/airspaceColors'
import { fmtNotamDate, type NotamItem } from '@open-vfr/shared/fetchNotam'
import { extractDesignators } from '@open-vfr/shared/notamDesignator'

export interface AirspaceFeatureProps {
  name:       string
  class:      string
  type?:      string
  lower?:     string
  upper?:     string
  lower_ft?:  number
  upper_ft?:  number
  remarks?:   string
  frequencies?: { freq_mhz: number; callsign: string; service: string }[]
  /** Exterior ring of the polygon [[lng,lat]…] */
  coords?:    number[][]
}

/** An ad-hoc regional NOTAM hit (circle/polygon/point) geometrically
 *  covering the tapped point, plus its rendered shape -- mirrors web's
 *  AirspacePopup.tsx RegionalNotamHit exactly (see that file's own doc
 *  comment). Undefined coords (point-only NOTAMs) falls back to
 *  PolygonThumb's plain-square placeholder. */
// `notams` is a group, not always a single NOTAM -- mirrors web's
// RegionalNotamHit exactly (see that file's own comment): a temporary area
// with no charted polygon yet commonly gets re-published as several NOTAM
// numbers (recurring daily activation, amendments), all referencing the
// same designator and landing on the same ad-hoc circle.
export interface RegionalNotamHit {
  notams:  NotamItem[]
  coords?: number[][]
}

// Groups ad-hoc hits sharing a designator code into one card -- mirrors
// web's AirspacePopup.tsx groupRegionalNotamHits() exactly, see that
// function's own comment for the full rationale.
function groupRegionalNotamHits(hits: RegionalNotamHit[]): RegionalNotamHit[] {
  const byKey = new Map<string, RegionalNotamHit>()
  const order: string[] = []
  for (const hit of hits) {
    for (const notam of hit.notams) {
      // Designator match first, else the NOTAM's own lat/lon/radiusNm
      // (rounded) -- mirrors web's AirspacePopup.tsx exactly, see that
      // file's own comment: confirmed live, several distinct single-
      // airport NOTAMs for the SAME foreign aerodrome (pulled in via the
      // cross-border geometry-inclusion path) share exact ARP coordinates
      // but reference no designator and have a null icaoLocation upstream.
      const designators = extractDesignators(notam.text)
      const geoKey = (notam.lat !== null && notam.lon !== null)
        ? `geo:${notam.lat.toFixed(3)}|${notam.lon.toFixed(3)}|${notam.radiusNm ?? ''}`
        : null
      const key = designators[0] ?? geoKey ?? `nmsId:${notam.nmsId}`
      let group = byKey.get(key)
      if (!group) {
        group = { notams: [], coords: hit.coords }
        byKey.set(key, group)
        order.push(key)
      }
      if (!group.notams.some((n) => n.nmsId === notam.nmsId)) group.notams.push(notam)
    }
  }
  return order.map((key) => byKey.get(key)!)
}

interface Props {
  features: AirspaceFeatureProps[]
  // Ad-hoc regional NOTAM circles/polygons/points geometrically covering the
  // tapped point -- rendered as their own sibling cards ahead of charted
  // airspace rows, same ordering/merge rationale as web's AirspacePopup.tsx.
  regionalNotams?: RegionalNotamHit[]
  onClose:  () => void
}

const NOTAM_COLOR = '#e64980'

// ── colour map ────────────────────────────────────────────────────────────────
// class C needs the type (CTR vs TMA) to pick the right shade — a flat
// class-only lookup previously always showed the CTR colour for TMA too,
// same bug class as the web popup and the native map layer fixed earlier.
function classBorderColor(cls: string, type?: string): string {
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
function classFillColor(cls: string, type?: string): string {
  if (cls === 'C') return type === 'CTR' ? AC.cCtrFill : AC.cTmaFill
  switch (cls) {
    case 'D':     return AC.dFill
    case 'E':     return AC.eFill
    case 'G':     return AC.gFill
    case 'R':     return AC.rFill
    case 'TRA':   return AC.traFill
    case 'GLDR':  return AC.gldrFill
    case 'MODEL': return AC.modelFill
    default:      return 'rgba(128,128,128,0.1)'
  }
}
const CLASS_LABEL: Record<string, string> = {
  C: 'Class C', D: 'Class D', E: 'Class E', G: 'Class G',
  R: 'Restricted', TRA: 'TRA', GLDR: 'Glider', MODEL: 'Model',
}
const TYPE_LABEL: Record<string, string> = {
  CTR: 'CTR', TMA: 'TMA', CTA: 'CTA', FIR: 'FIR', UIR: 'UIR',
  D: 'Danger', R: 'Restricted', P: 'Prohibited',
  TRA: 'TRA', GLDR: 'Glider', MODEL: 'Model',
}

// ── polygon → SVG path ───────────────────────────────────────────────────────
const VB    = 100   // viewBox size
const MARG  =   8   // margin inside viewBox

function coordsToPath(ring: number[][]): string {
  if (!ring || ring.length < 3) return ''

  // Apply Mercator-like longitude correction for the polygon's latitude
  // so the thumbnail aspect ratio matches what's drawn on the map.
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
  const use = VB - 2 * MARG

  // Uniform scale — preserve aspect ratio (same as map projection)
  const scale = Math.min(use / rX, use / rY)
  const drawW = rX * scale
  const drawH = rY * scale
  const offX  = MARG + (use - drawW) / 2
  const offY  = MARG + (use - drawH) / 2

  const pts = ring.map(([lng, lat]) => {
    const x  = lng * cosLat
    const sx = offX + ((x   - minX) / rX) * drawW
    const sy = offY + ((maxY - lat)  / rY) * drawH  // flip Y: lat↑ → SVG y↓
    return `${sx.toFixed(2)},${sy.toFixed(2)}`
  })
  return `M${pts.join('L')}Z`
}

// ── sub-components ───────────────────────────────────────────────────────────
function PolygonThumb({ coords, strokeColor, fillColor, active }: {
  coords?:     number[][]
  strokeColor: string
  fillColor:   string
  active:      boolean
}) {
  const thumbStyles = useThemedStyles(makeThumbStyles)
  const d = coords ? coordsToPath(coords) : ''
  return (
    <View style={[thumbStyles.wrap, active && thumbStyles.active]}>
      <Svg viewBox={`0 0 ${VB} ${VB}`} width="100%" height="100%">
        {d ? (
          <Path
            d={d}
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth={active ? 2.5 : 1.5}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          /* fallback: simple coloured square when no geometry */
          <Path
            d={`M${MARG},${MARG}L${VB-MARG},${MARG}L${VB-MARG},${VB-MARG}L${MARG},${VB-MARG}Z`}
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth={1.5}
          />
        )}
      </Svg>
    </View>
  )
}

function makeThumbStyles(theme: ScaledTheme) {
 return {
  wrap: {
    width: 44, height: 44,
    borderRadius: theme.radiusSm,
    overflow: 'hidden',
    flexShrink: 0,
  },
  active: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
} as const
}

// ── Shared altitude-relationship strip ───────────────────────────
// Ported from web's AirspacePopup.tsx — shows how ALL zones at this point
// stack vertically (SFC to ceiling) at a glance, complementary to the
// per-row polygon shape thumbnails (which show geographic outline, not
// altitude relationship). Genuinely different information, not redundant.
/** upper_ft at or above this → treat as Unlimited. */
const UNL_THRESHOLD_FT = 60_000
/** Y-axis cap for the diagram when UNL is present (FL200). */
const DIAGRAM_CAP_FT   = 20_000

function diagramMaxFt(list: AirspaceFeatureProps[]): number {
  const raw = Math.max(...list.map((f) => f.upper_ft ?? 0))
  return raw >= UNL_THRESHOLD_FT ? DIAGRAM_CAP_FT : raw
}

/** Y = 0 (top) is maximum altitude; Y = 100 (bottom) is SFC (0 ft). */
function diagramY(ft: number, maxFt: number): number {
  return 100 - (Math.min(ft, maxFt) / maxFt) * 100
}

function AltitudeStrip({ list, height }: { list: AirspaceFeatureProps[]; height: number }) {
  const stripStyles = useThemedStyles(makeStripStyles)
  const withAlt = list.filter(f => f.upper_ft != null && f.lower_ft != null)
  if (withAlt.length === 0 || height <= 0) return null
  const maxFt  = diagramMaxFt(withAlt)
  const hasUnl = withAlt.some(f => (f.upper_ft ?? 0) >= UNL_THRESHOLD_FT)
  const topLabel = hasUnl ? 'UNL' : `${withAlt.reduce((m, f) => Math.max(m, f.upper_ft ?? 0), 0)} ft`
  // Reserve space for the top/bottom text labels so the SVG rail doesn't
  // overlap them — mirrors web's stripWrap flex column (label/svg/label).
  const svgH = Math.max(20, height - 28)

  return (
    <View style={[stripStyles.wrap, { height }]}>
      <Text style={stripStyles.label} numberOfLines={1}>{topLabel}</Text>
      <Svg viewBox="0 0 12 100" width={12} height={svgH} preserveAspectRatio="none">
        <Rect x={4} y={0} width={4} height={100} fill="rgba(255,255,255,0.07)" rx={1.5} />
        {withAlt.map((f, i) => {
          const topY = diagramY(f.upper_ft ?? 0, maxFt)
          const botY = diagramY(f.lower_ft ?? 0, maxFt)
          return (
            <Rect
              key={i}
              x={4}
              y={topY}
              width={4}
              height={Math.max(botY - topY, 1.5)}
              fill={classBorderColor(f.class ?? '', f.type)}
              opacity={0.9}
            />
          )
        })}
        <Line x1={2} y1={100} x2={10} y2={100} stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
      </Svg>
      <Text style={stripStyles.label}>SFC</Text>
    </View>
  )
}

function makeStripStyles(theme: ScaledTheme) {
 return {
  wrap: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: theme.space1,
    flexShrink: 0,
  },
  label: {
    color: theme.textFaint,
    fontSize: 8,
  },
} as const
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const detailStyles = useThemedStyles(makeDetailStyles)
  return (
    <View style={detailStyles.row}>
      <Text style={detailStyles.label}>{label}</Text>
      <Text style={detailStyles.value}>{value}</Text>
    </View>
  )
}
function makeDetailStyles(theme: ScaledTheme) {
 return {
  row:   { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  label: { color: theme.textMuted,   fontSize: theme.textXs },
  value: { color: theme.textPrimary, fontSize: theme.textXs, fontWeight: '600' },
} as const
}

// ── helpers ───────────────────────────────────────────────────────────────────
function altBadge(f: AirspaceFeatureProps): string {
  const lo = f.lower ?? (f.lower_ft != null ? `${f.lower_ft} ft` : 'GND')
  const hi = f.upper ?? (f.upper_ft != null ? `${f.upper_ft} ft` : '—')
  return `${lo} – ${hi}`
}
function utcNow(): string {
  const d   = new Date()
  const hh  = String(d.getUTCHours()).padStart(2, '0')
  const mm  = String(d.getUTCMinutes()).padStart(2, '0')
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()]
  const mon = d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })
  return `${day} ${String(d.getUTCDate()).padStart(2,'0')} ${mon} ${hh}:${mm}z`
}
function sortByLower(list: AirspaceFeatureProps[]) {
  return [...list].sort((a, b) => (a.lower_ft ?? 0) - (b.lower_ft ?? 0))
}

// ── main component ────────────────────────────────────────────────────────────
export function AirspacePopup({ features, regionalNotams = [], onClose }: Props) {
  const styles = useThemedStyles(makeStyles)
  // Independently-collapsible rows -- keyed by string so NOTAM and charted
  // airspace rows (each own index space) never collide, and multiple rows
  // can be expanded at once (not a single-open accordion). Collapsed
  // (default) shows only the header line -- name/badges/altitude; expanded
  // reveals remarks, frequencies, and NOTAM detail. Mirrors web's
  // AirspacePopup.tsx `expanded` Set exactly.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const toggleRow = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }
  const [rowsHeight, setRowsHeight] = useState(0)

  // Dedup regional NOTAMs by nmsId (NOT the display id -- different issuing
  // authorities reuse the same published NOTAM number, see
  // apps/api/src/notam.ts's NotamItem.nmsId comment), THEN group same-
  // designator hits into one card -- mirrors web exactly, see
  // groupRegionalNotamHits()'s own comment.
  const seenNotamIds = new Set<string>()
  const dedupedNotams = groupRegionalNotamHits(regionalNotams).map((h) => ({
    ...h,
    notams: h.notams.filter((n) => {
      if (seenNotamIds.has(n.nmsId)) return false
      seenNotamIds.add(n.nmsId)
      return true
    }),
  })).filter((h) => h.notams.length > 0)

  if (features.length === 0 && dedupedNotams.length === 0) return null
  const sorted = sortByLower(features)
  const totalCount = sorted.length + dedupedNotams.length

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
      <View style={styles.sheet}>

        {/* header */}
        <View style={styles.sheetHeader}>
          <View>
            <Text style={styles.countTxt}>
              {totalCount} layer{totalCount !== 1 ? 's' : ''}
            </Text>
            <Text style={styles.timeTxt}>Now: {utcNow()}</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeTxt}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* accordion + altitude-relationship strip — the strip spans the full
            measured height of the row list, acting as a persistent ruler
            alongside it (mirrors web's absolutely-positioned stripWrap).
            Only reflects charted airspace (regional NOTAMs carry no
            comparable vertical-extent shape), same as web. */}
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
        <View style={styles.listRow}>
          <AltitudeStrip list={sorted} height={rowsHeight} />
          <View style={styles.rowsCol} onLayout={(e) => setRowsHeight(e.nativeEvent.layout.height)}>
          {dedupedNotams.map((hit, i) => {
            const group = hit.notams
            const n     = group[0]
            const key   = `notam-${i}`
            const isOpen = expandedKeys.has(key)
            return (
              <View key={key} style={styles.item}>
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => toggleRow(key)}
                  activeOpacity={0.7}
                >
                  <PolygonThumb
                    coords={hit.coords}
                    strokeColor={NOTAM_COLOR}
                    fillColor="rgba(230,73,128,0.13)"
                    active={isOpen}
                  />
                  <View style={styles.info}>
                    <View style={styles.badges}>
                      <View style={[styles.badge, { borderColor: NOTAM_COLOR }]}>
                        <Text style={[styles.badgeTxt, { color: NOTAM_COLOR }]}>NOTAM</Text>
                      </View>
                      {group.length > 1 && (
                        <View style={[styles.badge, { borderColor: NOTAM_COLOR }]}>
                          <Text style={[styles.badgeTxt, { color: NOTAM_COLOR }]}>{group.length}</Text>
                        </View>
                      )}
                      {(n.effective || n.expires) && (
                        <View style={styles.altBadge}>
                          <Text style={styles.altTxt} numberOfLines={1}>
                            {fmtNotamDate(n.effective) ?? '—'} – {fmtNotamDate(n.expires) ?? '—'}
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.name} numberOfLines={1}>
                      {n.id}{group.length > 1 ? ` +${group.length - 1} more` : ''}
                    </Text>
                  </View>
                  <Text style={[styles.chevron, isOpen && styles.chevronOpen]}>›</Text>
                </TouchableOpacity>
                {isOpen && (
                  <View style={styles.expandedContent}>
                    {group.map((gn) => (
                      <View key={gn.nmsId} style={{ marginBottom: 6 }}>
                        {group.length > 1 && (
                          <Text style={[styles.notamText, { fontWeight: '700' }]}>
                            NOTAM {gn.id}{gn.effective ? ` · ${fmtNotamDate(gn.effective)}` : ''}{gn.expires ? ` – ${fmtNotamDate(gn.expires)}` : ''}
                          </Text>
                        )}
                        <Text style={styles.notamText}>{gn.text}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )
          })}
          {sorted.map((f, i) => {
            const cls    = f.class ?? ''
            const color  = classBorderColor(cls, f.type)
            const fill   = classFillColor(cls, f.type)
            const key    = `feature-${i}`
            const isOpen = expandedKeys.has(key)

            return (
              <View key={i} style={styles.item}>
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => toggleRow(key)}
                  activeOpacity={0.7}
                >
                  <PolygonThumb
                    coords={f.coords}
                    strokeColor={color}
                    fillColor={fill}
                    active={isOpen}
                  />

                  <View style={styles.info}>
                    <Text style={styles.name} numberOfLines={1}>{f.name}</Text>
                    <View style={styles.badges}>
                      {f.type && (
                        <View style={[styles.badge, { borderColor: color }]}>
                          <Text style={[styles.badgeTxt, { color }]}>
                            {TYPE_LABEL[f.type] ?? f.type}
                          </Text>
                        </View>
                      )}
                      {cls && (
                        <View style={[styles.badge, { borderColor: color }]}>
                          <Text style={[styles.badgeTxt, { color }]}>
                            {CLASS_LABEL[cls] ?? cls}
                          </Text>
                        </View>
                      )}
                      <View style={styles.altBadge}>
                        <Text style={styles.altTxt}>{altBadge(f)}</Text>
                      </View>
                    </View>
                  </View>

                  <Text style={[styles.chevron, isOpen && styles.chevronOpen]}>›</Text>
                </TouchableOpacity>

                {isOpen && (
                  <View style={styles.expandedContent}>
                    {f.type && <DetailRow label="Type"  value={TYPE_LABEL[f.type] ?? f.type} />}
                    <DetailRow label="Lower" value={f.lower ?? (f.lower_ft != null ? `${f.lower_ft} ft` : 'GND')} />
                    <DetailRow label="Upper" value={f.upper ?? (f.upper_ft != null ? `${f.upper_ft} ft` : '—')} />
                    {f.lower_ft != null && f.upper_ft != null && (
                      <DetailRow label="Thickness" value={`${(f.upper_ft - f.lower_ft).toLocaleString()} ft`} />
                    )}
                    {f.frequencies && f.frequencies.length > 0 && (
                      <View style={styles.section}>
                        <Text style={styles.sectionLabel}>Frequencies</Text>
                        {f.frequencies.map((fr, fi) => (
                          <View key={fi} style={styles.freqRow}>
                            <Text style={styles.freqVal}>{fr.freq_mhz.toFixed(3)}</Text>
                            {fr.callsign ? (
                              <Text style={styles.freqCs}>{fr.callsign}</Text>
                            ) : null}
                          </View>
                        ))}
                      </View>
                    )}
                    {!f.frequencies && f.class === 'G' && (
                      <View style={styles.section}>
                        <Text style={styles.sectionLabel}>Frequencies</Text>
                        <Text style={styles.fisHint}>
                          FIS frequency varies by sector — check nearest aerodrome or AIP ENR 2.2
                        </Text>
                      </View>
                    )}
                    {f.remarks ? (
                      <View style={styles.section}>
                        <Text style={styles.sectionLabel}>Remarks</Text>
                        <Text style={styles.remarksText}>{f.remarks}</Text>
                      </View>
                    ) : null}
                  </View>
                )}
              </View>
            )
          })}
          </View>
        </View>
        </ScrollView>
      </View>
    </Modal>
  )
}

// ── styles ────────────────────────────────────────────────────────────────────
function makeStyles(theme: ScaledTheme) {
 return {
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor:      theme.surfacePanel,
    borderTopLeftRadius:  theme.radiusLg,
    borderTopRightRadius: theme.radiusLg,
    borderTopWidth:       1,
    borderColor:          theme.borderDefault,
    maxHeight:            '75%',
  },
  sheetHeader: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: theme.space4,
    paddingVertical:   theme.space3,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  countTxt: { color: theme.textPrimary, fontSize: theme.textMd, fontWeight: '700' },
  timeTxt:  { color: theme.textMuted,   fontSize: theme.textXs, marginTop: 2 },
  closeBtn: { padding: theme.space2 },
  closeTxt: { color: theme.textMuted, fontSize: theme.textMd },
  list:     { paddingBottom: theme.space4 },
  listRow:  { flexDirection: 'row' },
  rowsCol:  { flex: 1 },

  item: { borderBottomWidth: 1, borderBottomColor: theme.borderSubtle },
  row: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingVertical:   theme.space3,
    paddingHorizontal: theme.space4,
    gap:               theme.space3,
  },
  info:   { flex: 1, gap: 4 },
  name:   { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '600' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },

  badge: {
    borderWidth: 1, borderRadius: 4,
    paddingHorizontal: 4, paddingVertical: 1,
  },
  badgeTxt: { fontSize: 10, fontWeight: '700' },

  altBadge: {
    borderWidth:       1,
    borderColor:       'rgb(184,212,245)',
    borderRadius:      4,
    paddingHorizontal: 4,
    paddingVertical:   1,
    backgroundColor:   'rgba(220,240,255,0.12)',
  },
  altTxt: { fontSize: 10, fontWeight: '500', color: theme.textSecondary },

  chevron:     { color: theme.textMuted, fontSize: 20 },
  chevronOpen: { transform: [{ rotate: '90deg' }] },

  expandedContent: {
    paddingHorizontal: theme.space4 + 44 + theme.space3,
    paddingBottom:     theme.space3,
    gap:               2,
  },
  section: {
    marginTop:  theme.space2,
    gap:        2,
  },
  sectionLabel: {
    color:      theme.textMuted,
    fontSize:   theme.textXs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing:  0.5,
    marginBottom:   2,
  },
  freqRow: {
    flexDirection: 'row',
    gap:           theme.space2,
    paddingVertical: 1,
  },
  freqVal: {
    color:      theme.accentBlue,
    fontSize:   theme.textSm,
    fontWeight: '700',
    minWidth:   60,
  },
  freqCs: {
    color:    theme.textSecondary,
    fontSize: theme.textXs,
    flexShrink: 1,
  },
  remarksText: {
    color:      theme.textSecondary,
    fontSize:   theme.textXs,
    lineHeight: 16,
  },
  fisHint: {
    color:      theme.textFaint,
    fontSize:   theme.textXs,
    fontStyle:  'italic',
    lineHeight: 16,
  },
  notamText: {
    color:      theme.textSecondary,
    fontSize:   theme.textXs,
    lineHeight: 16,
    marginTop:  2,
  },
} as const
}
