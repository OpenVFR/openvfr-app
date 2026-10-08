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

import React from 'react'
import {
  View, Text, TouchableOpacity, TextInput,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { NativeSheet } from './NativeSheet'
import { AltitudeSlider } from './AltitudeSlider'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import { AIRSPACE_COLORS as AC } from '@open-vfr/shared/airspaceColors'
import { AERODROME_COLORS, NAVAID_COLORS, WAYPOINT_COLORS, OBSTACLE_COLORS } from '@open-vfr/shared/featureColors'

// ---------------------------------------------------------------------------
// Layer state — exported so MapScreen owns it
// ---------------------------------------------------------------------------
export type LayerState = {
  // Airspace per-class
  classCtr:   boolean   // CTR (Class C control zones)
  classCtma:  boolean   // TMA / CTA (other Class C polygons)
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
  classCtr:   true,
  classCtma:  true,
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
  landmarks:  true,
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
  { key: 'classCtr',   label: 'CTR',              color: AC.cCtrBorder  },
  { key: 'classCtma',  label: 'TMA / CTA',        color: AC.cTmaBorder  },
  { key: 'classG',     label: 'RMZ / ATZ / TMZ',        color: AC.gBorder     },
  { key: 'restricted', label: 'Restricted / Danger / TRA', color: AC.rBorder     },
  { key: 'activity',   label: 'Glider / Model',    color: AC.gldrBorder  },
  // FIR-wide regional NOTAM circles -- grouped with airspace filters (matches
  // web's map-style.ts LAYER_GROUPS placement), not with live traffic below.
  { key: 'notamCircles', label: 'Regional NOTAMs', color: '#e64980' },
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
  onLayerChange:    (key: keyof LayerState, on: boolean) => void
  /** Flight mode is on: the Satellite basemap option is disabled (see
   *  MapScreen's satellite-in-flight lock). */
  satelliteLocked?: boolean
  /** True on devices below the RAM tier deemed safe for hillshade/contours/
   *  terrainColor (see utils/deviceMemory.ts) -- those three rows are
   *  disabled and their persisted state is forced off (MapScreen effect),
   *  same pattern as satelliteLocked above. */
  terrainMemoryLocked?: boolean
  onCeilingChange:  (ft: number) => void
  /** Reference altitude (ft MSL) for the terrain colour-relief bands --
   *  same concept as web's SettingsPanel terrainColoring.refAltFt, now
   *  living alongside the toggle itself instead of a separate settings
   *  screen (matches web's LayerPanel placement). */
  terrainColorRefAltFt:          number
  onTerrainColorRefAltFtChange:  (ft: number) => void
  /** True once airborne -- ref-alt input is replaced by a "using GPS alt"
   *  note, same as web's `inFlight` gate in SettingsPanel/LayerPanel. */
  inFlight?: boolean
}

export function MapDisplaySheet({
  layers, ceilingFt, onLayerChange, onCeilingChange,
  terrainColorRefAltFt, onTerrainColorRefAltFtChange, inFlight, satelliteLocked,
  terrainMemoryLocked,
}: Props) {
  const styles = useThemedStyles(makeStyles)
  const captionStyles = useThemedStyles(makeCaptionStyles)
  const refAltStyles = useThemedStyles(makeRefAltStyles)
  const [open, setOpen] = React.useState(false)
  const [refAltText, setRefAltText] = React.useState(String(terrainColorRefAltFt))
  React.useEffect(() => { setRefAltText(String(terrainColorRefAltFt)) }, [terrainColorRefAltFt])

  return (
    <>
      {/* Trigger button */}
      <TouchableOpacity style={styles.trigger} onPress={() => setOpen(true)} testID="map-display-open" accessibilityLabel="Map display">
        <Ionicons name="layers-outline" size={20} color={theme.textSecondary} />
      </TouchableOpacity>

      {/* Native bottom sheet (Compose ModalBottomSheet / SwiftUI sheet) --
          dimming, corners, drag-to-dismiss and safe areas all come from the
          platform, not hand-built. containerColor matches the app's active
          theme since the native default wouldn't. */}
      <NativeSheet
        isPresented={open}
        onDismiss={() => setOpen(false)}
        title="Map Display"
        testID="map-display-sheet"
        closeTestID="map-display-close"
      >
        <View>
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
                style={[styles.basemapBtn, layers.satellite && styles.basemapBtnActive, satelliteLocked && styles.basemapBtnDisabled]}
                onPress={() => onLayerChange('satellite', true)}
                disabled={!!satelliteLocked}
                accessibilityState={{ disabled: !!satelliteLocked, selected: layers.satellite }}
              >
                <Text style={[styles.basemapTxt, layers.satellite && styles.basemapTxtActive]}>Satellite</Text>
              </TouchableOpacity>
            </View>
            {satelliteLocked && (
              <Text style={styles.basemapNote}>Satellite imagery is planning-only and switches off in flight.</Text>
            )}

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
            {/* Terrain layers never draw over satellite imagery (MapScreen
                gates them on !layers.satellite): the imagery already shows
                the ground, and landuse/hillshade fills would paint over it.
                The rows keep their saved state and come back with vector. */}
            {layers.satellite && (
              <Text style={styles.basemapNote}>Terrain layers are hidden in satellite view.</Text>
            )}
            {terrainMemoryLocked && (
              <Text style={styles.basemapNote}>
                Hillshade, Contour Lines and Terrain Color are disabled on this device to
                avoid running out of memory. Terrain (landuse) is unaffected.
              </Text>
            )}
            {TERRAIN_GROUPS.map(g => {
              const heavyLocked = terrainMemoryLocked && g.key !== 'landuse'
              return (
                <LayerRow key={g.key} label={g.label} color={g.color}
                  on={layers[g.key]} onToggle={() => onLayerChange(g.key, !layers[g.key])}
                  disabled={layers.satellite || heavyLocked} />
              )
            })}
            {layers.terrainColor && !layers.satellite && (
              <>
                <Text style={captionStyles.warning}>
                  ⚠ Experimental: known GPU rendering bug on some Android devices
                  (Adreno chipsets). Check colours render correctly (green/yellow/
                  orange/red bands, not all-brown or a single flat colour) before
                  relying on this.
                </Text>
                <View style={refAltStyles.row}>
                  <Text style={refAltStyles.label}>Reference altitude</Text>
                  {inFlight ? (
                    <Text style={refAltStyles.live}>using GPS alt</Text>
                  ) : (
                    <View style={refAltStyles.inputWrap}>
                      <TextInput
                        style={refAltStyles.input}
                        value={refAltText}
                        keyboardType="number-pad"
                        onChangeText={setRefAltText}
                        onEndEditing={() => {
                          const v = parseInt(refAltText, 10)
                          if (!isNaN(v) && v > 0) onTerrainColorRefAltFtChange(v)
                          else setRefAltText(String(terrainColorRefAltFt))
                        }}
                      />
                      <Text style={refAltStyles.unit}>ft</Text>
                    </View>
                  )}
                </View>
              </>
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

            <View style={{ height: 16 }} />
          </View>
      </NativeSheet>
    </>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function SectionHeader({ title }: { title: string }) {
  const sectionStyles = useThemedStyles(makeSectionStyles)
  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.title}>{title.toUpperCase()}</Text>
      <View style={sectionStyles.line} />
    </View>
  )
}

function LayerRow({ label, color, on, onToggle, disabled }: {
  label: string; color: string; on: boolean; onToggle: () => void; disabled?: boolean
}) {
  const rowStyles = useThemedStyles(makeRowStyles)
  return (
    <TouchableOpacity
      style={[rowStyles.row, !on && rowStyles.rowOff, disabled && { opacity: 0.4 }]}
      onPress={onToggle}
      disabled={disabled}
      accessibilityState={{ disabled: !!disabled, checked: on }}
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
function makeStyles(theme: ScaledTheme) {
 return {
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
  sheetInner: {
    flex: 1,
    paddingBottom: 8,
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
  basemapBtnDisabled: { opacity: 0.4 },
  basemapNote: {
    fontSize:   11,
    color:      theme.textFaint,
    paddingTop: 4,
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
} as const
}

function makeSectionStyles(theme: ScaledTheme) {
 return {
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
} as const
}

function makeCaptionStyles(theme: ScaledTheme) {
 return {
  warning: {
    color:             theme.accentYellow,
    fontSize:          11,
    lineHeight:        15,
    paddingHorizontal: theme.space4,
    paddingBottom:     theme.space2,
  },
} as const
}

function makeRefAltStyles(theme: ScaledTheme) {
 return {
  row: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: theme.space4,
    paddingBottom:     theme.space2,
  },
  label: {
    color:    theme.textMuted,
    fontSize: theme.textSm,
  },
  live: {
    color:      theme.accentGreen,
    fontSize:   theme.textXs,
    fontStyle:  'italic',
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
  },
  input: {
    width:           64,
    backgroundColor: theme.surfaceOverlay,
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    borderRadius:    theme.radiusSm,
    color:           theme.textPrimary,
    fontSize:        theme.textSm,
    paddingVertical: 2,
    paddingHorizontal: 6,
    textAlign:       'right',
  },
  unit: {
    color:    theme.textFaint,
    fontSize: theme.textXs,
  },
} as const
}

function makeRowStyles(theme: ScaledTheme) {
 return {
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
} as const
}
