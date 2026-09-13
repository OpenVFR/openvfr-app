/**
 * MapDisplaySheet — consolidated map display controls.
 *
 * Single floating button opens a bottom sheet containing:
 *   - Airspace ceiling slider (always at top — most-used control in flight)
 *   - Per-class airspace toggles
 *   - Points layer toggles (aerodromes, navaids, waypoints, obstacles, runways)
 *
 * Replaces the old LayerPanel component.
 */

import React, { useRef } from 'react'
import {
  View, Text, TouchableOpacity, Modal, ScrollView,
  StyleSheet, Animated, PanResponder,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { AltitudeSlider } from './AltitudeSlider'
import { theme } from '../styles/theme'
import { AIRSPACE_COLORS as AC } from '@open-vfr/shared/airspaceColors'
import { AERODROME_COLORS, NAVAID_COLORS, WAYPOINT_COLORS, OBSTACLE_COLORS } from '@open-vfr/shared/featureColors'

// ---------------------------------------------------------------------------
// Layer state — exported so MapScreen owns it
// ---------------------------------------------------------------------------
export type LayerState = {
  // Airspace per-class
  classC:     boolean   // CTR + TMA
  classD:     boolean   // Class D / Danger
  classE:     boolean   // Class E
  classG:     boolean   // RMZ / ATZ
  restricted: boolean   // R + TRA
  activity:   boolean   // Glider / Model (off by default)
  // Point features
  aerodromes: boolean
  navaids:    boolean
  waypoints:  boolean
  obstacles:  boolean
  runways:    boolean
  // Live data
  traffic:    boolean
  // FIR-wide regional NOTAM circles (restricted/danger areas, navaid
  // outages, military notices) -- see apps/native/src/hooks/useRegionalNotams.ts
  notamCircles: boolean
  // Basemap
  satellite:  boolean
  // VFR landmarks
  landmarks:  boolean
  // OSM landuse fills (farmland/residential/wetland/etc.), self-hosted
  // PMTiles -- matches web's 'terrain' (landuse) LAYER_GROUP. On by default,
  // same as web.
  landuse: boolean
  // Terrain relief shading (Copernicus GLO-30 DEM, self-hosted PMTiles)
  hillshade:  boolean
  // EXPERIMENTAL -- terrain colour-relief (color-relief layer type). Known
  // GPU/Adreno rendering bug on some Android devices -- off by default,
  // exists to be verified on real hardware. See AGENTS.md.
  terrainColor: boolean
  // Elevation contour lines (Copernicus GLO-30 DEM, vector), same source
  // as web's 'contours' layer group (map-style.ts). Off by default.
  contours: boolean
  // Ambient wind-barb overlay (grid-sampled Open-Meteo wind, WMO-style
  // barb icons) -- matches web's 'wind' LAYER_GROUPS entry. Off by default,
  // same as web.
  wind: boolean
}

export const LAYER_DEFAULTS: LayerState = {
  classC:     true,
  classD:     true,
  classE:     true,
  classG:     true,
  restricted: true,
  activity:   false,
  aerodromes: true,
  navaids:    true,
  waypoints:  true,
  obstacles:  true,
  runways:    true,
  traffic:    false,
  notamCircles: true,
  satellite:  false,
  landmarks:  false,
  landuse: true,
  hillshade:  false,
  terrainColor: false,
  contours: false,
  wind: false,
}

// ---------------------------------------------------------------------------
// Group definitions
// ---------------------------------------------------------------------------
type Group = { key: keyof LayerState; label: string; color: string }

const AIRSPACE_GROUPS: Group[] = [
  { key: 'classC',     label: 'CTR / TMA',        color: AC.cCtrBorder  },
  { key: 'classD',     label: 'Class D',           color: AC.dBorder     },
  { key: 'classE',     label: 'Class E',           color: AC.eBorder     },
  { key: 'classG',     label: 'RMZ / ATZ',         color: AC.gBorder     },
  { key: 'restricted', label: 'Restricted / TRA',  color: AC.rBorder     },
  { key: 'activity',   label: 'Glider / Model',    color: AC.gldrBorder  },
]

// Order matches web's map-style.ts LAYER_GROUPS 'Navigation' section
// (navaids, waypoints, aerodromes, runways, obstacles, landmarks) --
// native collapses VOR/NDB and MRP/RP into single combined toggles, but
// keeps the same relative order as the two platforms' respective lists.
const POINTS_GROUPS: Group[] = [
  { key: 'navaids',    label: 'Navaids',    color: NAVAID_COLORS.vor        },
  { key: 'waypoints',  label: 'Waypoints',  color: WAYPOINT_COLORS.mrp      },
  { key: 'aerodromes', label: 'Aerodromes', color: AERODROME_COLORS.default },
  { key: 'runways',    label: 'Runways',    color: '#c0d0b8'                },
  { key: 'obstacles',  label: 'Obstacles',  color: OBSTACLE_COLORS.tower    },
  { key: 'landmarks',  label: 'Landmarks',  color: '#455a64'                },
]

const TRAFFIC_GROUPS: Group[] = [
  { key: 'traffic', label: 'Air Traffic (ADS-B)', color: '#22c55e' },
  { key: 'notamCircles', label: 'Regional NOTAMs', color: '#e64980' },
]

// Matches web's LAYER_GROUPS 'Weather' section ('Wind Arrows' entry) --
// same sky-blue swatch as WIND_BARB_COLOR (apps/web/src/utils/windBarbIcons.ts).
const WEATHER_GROUPS: Group[] = [
  { key: 'wind', label: 'Wind Arrows', color: '#38bdf8' },
]

// Order matches web's Terrain section (map-style.ts LAYER_GROUPS): hillshade,
// then contours -- native has no separate 'Terrain (landuse)' toggle (its
// landuse-fill layer is always rendered, unconditional), so hillshade is
// first here same as web's second Terrain entry. terrainColor is native-only
// (no web equivalent) and kept last so it doesn't interrupt the shared order.
const TERRAIN_GROUPS: Group[] = [
  { key: 'landuse',      label: 'Terrain (landuse)',                color: '#c9a876' },
  { key: 'hillshade',    label: 'Hillshade (relief)',              color: '#8d6e63' },
  { key: 'contours',     label: 'Contour Lines',                   color: '#785023' },
  { key: 'terrainColor', label: 'Terrain Color (EXPERIMENTAL)',    color: '#ef4444' },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
interface Props {
  layers:      LayerState
  ceilingFt:   number
  autoZoom:    boolean
  onLayerChange:    (key: keyof LayerState, on: boolean) => void
  onCeilingChange:  (ft: number) => void
  onAutoZoomChange: (on: boolean) => void
}

export function MapDisplaySheet({ layers, ceilingFt, autoZoom, onLayerChange, onCeilingChange, onAutoZoomChange }: Props) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      {/* Trigger button */}
      <TouchableOpacity style={styles.trigger} onPress={() => setOpen(true)}>
        <Ionicons name="layers-outline" size={20} color={theme.textSecondary} />
      </TouchableOpacity>

      {/* Bottom sheet */}
      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        />

        <View style={styles.sheet}>
          {/* Handle */}
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Map Display</Text>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            {/* ── Ceiling ─────────────────────────────────────── */}
            {/* ── Basemap ──────────────────────────────── */}
            <SectionHeader title="Basemap" />
            <View style={styles.basemapRow}>
              <TouchableOpacity
                style={[styles.basemapBtn, !layers.satellite && styles.basemapBtnActive]}
                onPress={() => onLayerChange('satellite', false)}
              >
                <Text style={[styles.basemapTxt, !layers.satellite && styles.basemapTxtActive]}>Vector</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.basemapBtn, layers.satellite && styles.basemapBtnActive]}
                onPress={() => onLayerChange('satellite', true)}
              >
                <Text style={[styles.basemapTxt, layers.satellite && styles.basemapTxtActive]}>Satellite</Text>
              </TouchableOpacity>
            </View>

            {/* ── Airspace Ceiling ───────────────────────── */}
            <SectionHeader title="Airspace Ceiling" />
            <View style={styles.sliderWrap}>
              <AltitudeSlider ceilingFt={ceilingFt} onChange={onCeilingChange} />
            </View>

            {/* ── Airspace ────────────────────────────────────── */}
            <SectionHeader title="Airspace" />
            {AIRSPACE_GROUPS.map(g => (
              <LayerRow
                key={g.key}
                label={g.label}
                color={g.color}
                on={layers[g.key]}
                onToggle={() => onLayerChange(g.key, !layers[g.key])}
              />
            ))}

            {/* ── Points ──────────────────────────────── */}
            <SectionHeader title="Points" />
            {POINTS_GROUPS.map(g => (
              <LayerRow key={g.key} label={g.label} color={g.color}
                on={layers[g.key]} onToggle={() => onLayerChange(g.key, !layers[g.key])} />
            ))}

            {/* ── Live ───────────────────────────────── */}
            <SectionHeader title="Terrain" />
            {TERRAIN_GROUPS.map(g => (
              <LayerRow key={g.key} label={g.label} color={g.color}
                on={layers[g.key]} onToggle={() => onLayerChange(g.key, !layers[g.key])} />
            ))}
            {layers.terrainColor && (
              <Text style={captionStyles.warning}>
                ⚠ Experimental: known GPU rendering bug on some Android devices
                (Adreno chipsets). Check colours render correctly (green/yellow/
                orange/red bands, not all-brown or a single flat colour) before
                relying on this.
              </Text>
            )}

            <SectionHeader title="Weather" />
            {WEATHER_GROUPS.map(g => (
              <LayerRow key={g.key} label={g.label} color={g.color}
                on={layers[g.key]} onToggle={() => onLayerChange(g.key, !layers[g.key])} />
            ))}

            <SectionHeader title="Live" />
            {TRAFFIC_GROUPS.map(g => (
              <LayerRow key={g.key} label={g.label} color={g.color}
                on={layers[g.key]} onToggle={() => onLayerChange(g.key, !layers[g.key])} />
            ))}

            {/* ── Behaviour ───────────────────────────── */}
            <SectionHeader title="Behaviour" />
            <LayerRow
              label="Auto-zoom"
              color={theme.accentBlue}
              on={autoZoom}
              onToggle={() => onAutoZoomChange(!autoZoom)}
            />
            <View style={{ height: 16 }} />
          </ScrollView>
        </View>
      </Modal>
    </>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function SectionHeader({ title }: { title: string }) {
  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.title}>{title.toUpperCase()}</Text>
      <View style={sectionStyles.line} />
    </View>
  )
}

function LayerRow({ label, color, on, onToggle }: {
  label: string; color: string; on: boolean; onToggle: () => void
}) {
  return (
    <TouchableOpacity
      style={[rowStyles.row, !on && rowStyles.rowOff]}
      onPress={onToggle}
      activeOpacity={0.7}
    >
      <View style={[rowStyles.swatch, { backgroundColor: color }]} />
      <Text style={[rowStyles.label, !on && rowStyles.labelOff]}>{label}</Text>
      <View style={[rowStyles.pill, on && rowStyles.pillOn]}>
        <Text style={[rowStyles.pillTxt, on && rowStyles.pillTxtOn]}>
          {on ? 'ON' : 'OFF'}
        </Text>
      </View>
    </TouchableOpacity>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  trigger: {
    width:           40,
    height:          40,
    borderRadius:    theme.radiusMd,
    backgroundColor: 'rgba(19,24,36,0.90)',
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    alignItems:      'center',
    justifyContent:  'center',
  },
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    backgroundColor:    theme.surfacePanel,
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    borderTopWidth:     1,
    borderColor:        theme.borderDefault,
    maxHeight:          '80%',
    paddingBottom:      8,
  },
  handle: {
    width:           40,
    height:          4,
    borderRadius:    2,
    backgroundColor: theme.borderDefault,
    alignSelf:       'center',
    marginTop:       10,
    marginBottom:    4,
  },
  header: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: theme.space4,
    paddingVertical:   theme.space2,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  headerTitle: {
    color:      theme.textPrimary,
    fontSize:   theme.textMd,
    fontWeight: '700',
  },
  sliderWrap: {
    paddingHorizontal: theme.space2,
    paddingBottom:     theme.space1,
  },
  basemapRow: {
    flexDirection:     'row',
    paddingHorizontal: theme.space4,
    paddingVertical:   theme.space2,
    gap:               theme.space2,
  },
  basemapBtn: {
    flex:              1,
    paddingVertical:   theme.space2,
    borderRadius:      theme.radiusSm,
    borderWidth:       1,
    borderColor:       theme.borderDefault,
    alignItems:        'center',
    backgroundColor:   theme.surfaceOverlay,
  },
  basemapBtnActive: {
    borderColor:       theme.accentBlue,
    backgroundColor:   'rgba(59,130,246,0.15)',
  },
  basemapTxt: {
    color:      theme.textMuted,
    fontSize:   theme.textSm,
    fontWeight: '600',
  },
  basemapTxtActive: {
    color: theme.accentBlue,
  },
})

const sectionStyles = StyleSheet.create({
  container: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: theme.space4,
    paddingTop:        theme.space3,
    paddingBottom:     theme.space1,
    gap:               theme.space2,
  },
  title: {
    color:         theme.textFaint,
    fontSize:      theme.textXs,
    fontWeight:    '700',
    letterSpacing: 0.8,
  },
  line: {
    flex:            1,
    height:          1,
    backgroundColor: theme.borderSubtle,
  },
})

const captionStyles = StyleSheet.create({
  warning: {
    color:             theme.accentYellow,
    fontSize:          11,
    lineHeight:        15,
    paddingHorizontal: theme.space4,
    paddingBottom:     theme.space2,
  },
})

const rowStyles = StyleSheet.create({
  row: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: theme.space4,
    paddingVertical:   10,
    gap:               theme.space2,
  },
  rowOff: {
    opacity: 0.45,
  },
  swatch: {
    width:        10,
    height:       10,
    borderRadius: 2,
    flexShrink:   0,
  },
  label: {
    flex:     1,
    color:    theme.textSecondary,
    fontSize: theme.textSm,
  },
  labelOff: {
    color: theme.textMuted,
  },
  pill: {
    paddingHorizontal: 8,
    paddingVertical:   2,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       theme.borderDefault,
    backgroundColor:   theme.surfaceOverlay,
  },
  pillOn: {
    borderColor:     theme.accentBlue,
    backgroundColor: 'rgba(59,130,246,0.12)',
  },
  pillTxt: {
    fontSize:   theme.textXs,
    fontWeight: '700',
    color:      theme.textFaint,
  },
  pillTxtOn: {
    color: theme.accentBlue,
  },
})
