/**
 * FindDestinationSheet — native equivalent of web's FindDestPanel.tsx
 * ("Find a Destination" aerodrome picker), bottom-sheet wrapped the same
 * way as RegionalNotamsSheet/WeatherAlongRouteSheet. All parsing/filtering/
 * sorting logic lives in @open-vfr/shared/findDestination — shared 1:1
 * with the web panel.
 *
 * Filters: free-text search (ICAO / name), fuel type, surface, minimum
 * runway length. Row tap → pan map to aerodrome (onFlyTo). "+" button →
 * append aerodrome as a route waypoint (onAddToRoute).
 */

import React from 'react'
import { View, Text, TouchableOpacity, Modal, TextInput, FlatList } from 'react-native'
import Slider from '@react-native-community/slider'
import { Ionicons } from '@expo/vector-icons'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import { getTileUrls } from '../config'
import type { AircraftProfileDocType } from '../db'
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'
import {
  parseAerodromesGeoJson, filterAndSortAerodromes, computeGlideRangeNm,
  aerodromeToWaypoint, hasAvgas, hasJet, isHard, isGrass, fmtBrg, fmtDist,
  type AerodromeEntry, type AerodromeResult, type FuelFilter, type SurfaceFilter,
} from '@open-vfr/shared/findDestination'

interface Centre {
  lat: number
  lng: number
  /** altitude ft — used for glide range when > 200 ft */
  altFt?: number
}

interface Props {
  /** Current GPS/map centre used for distance sorting */
  center:           Centre
  homeIcao:         string | null
  aircraftProfile?: AircraftProfileDocType
  /** Pan the map to this location */
  onFlyTo:          (lat: number, lng: number) => void
  /** Append as a route waypoint */
  onAddToRoute:     (wp: RouteWaypoint) => void
}

const FUEL_OPTS: { v: FuelFilter; label: string }[] = [
  { v: 'any', label: 'Any' }, { v: 'avgas', label: 'AVGAS' }, { v: 'jet', label: 'JET A1' },
]
const SURF_OPTS: { v: SurfaceFilter; label: string }[] = [
  { v: 'any', label: 'Any' }, { v: 'hard', label: 'Hard' }, { v: 'grass', label: 'Grass' },
]

export function FindDestinationSheet({ center, homeIcao, aircraftProfile, onFlyTo, onAddToRoute }: Props) {
  const styles = useThemedStyles(makeStyles)
  const [open, setOpen] = React.useState(false)
  const [aerodromes, setAerodromes] = React.useState<AerodromeEntry[]>([])
  const [search, setSearch] = React.useState('')
  const [minRunwayM, setMinRunway] = React.useState(0)
  const [fuelFilter, setFuelFilter] = React.useState<FuelFilter>('any')
  const [surfFilter, setSurfFilter] = React.useState<SurfaceFilter>('any')

  // ── Load once, on first open ────────────────────────────────────────────
  React.useEffect(() => {
    if (!open || aerodromes.length > 0) return
    fetch(getTileUrls().aerodromes)
      .then(r => r.json())
      .then(fc => setAerodromes(parseAerodromesGeoJson(fc)))
      .catch(() => {})
  }, [open, aerodromes.length])

  const glideRangeNm = React.useMemo(
    () => computeGlideRangeNm(center, aircraftProfile),
    [center.altFt, aircraftProfile],
  )

  const sorted = React.useMemo(
    () => filterAndSortAerodromes(
      aerodromes, center, homeIcao,
      { search, minRunwayM, fuelFilter, surfFilter },
      glideRangeNm,
    ).slice(0, 80),
    [aerodromes, center, homeIcao, minRunwayM, fuelFilter, surfFilter, search, glideRangeNm],
  )

  const renderRow = ({ item: a }: { item: AerodromeResult }) => (
    <View style={[styles.row, a.icao === homeIcao && styles.rowHome, a.withinGlide && styles.rowGlide]}>
      <TouchableOpacity
        style={styles.rowMain}
        onPress={() => { onFlyTo(a.lat, a.lng); setOpen(false) }}
      >
        <View style={styles.rowTop}>
          <Text style={styles.rowIcao}>{a.icao}</Text>
          <Text style={styles.rowName} numberOfLines={1}>{a.name}</Text>
        </View>
        <View style={styles.rowBottom}>
          <View style={styles.rowTags}>
            {a.icao === homeIcao && <Text style={styles.tagHome}>HOME</Text>}
            {a.withinGlide && <Text style={styles.tagGlide}>GLIDE</Text>}
            {hasAvgas(a.fuel) && <Text style={styles.tag}>AVGAS</Text>}
            {hasJet(a.fuel) && <Text style={styles.tag}>JET</Text>}
            {isHard(a.surfaces) && <Text style={styles.tag}>ASPH</Text>}
            {isGrass(a.surfaces) && !isHard(a.surfaces) && <Text style={styles.tagGrass}>GRASS</Text>}
            {a.maxRunwayM > 0 && <Text style={styles.tag}>{a.maxRunwayM}m</Text>}
          </View>
          <Text style={styles.rowNav}>{fmtDist(a.dist)} · {fmtBrg(a.bearing)}</Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.addBtn}
        onPress={() => onAddToRoute(aerodromeToWaypoint(a))}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="add" size={18} color={theme.textPrimary} />
      </TouchableOpacity>
    </View>
  )

  return (
    <>
      <TouchableOpacity style={styles.trigger} onPress={() => setOpen(true)}>
        <Ionicons name="search-outline" size={20} color={theme.textSecondary} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Find a Destination</Text>
            {glideRangeNm !== null && (
              <Text style={styles.glideNote}>⬡ Glide {glideRangeNm.toFixed(0)} NM</Text>
            )}
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={styles.filters}>
            <TextInput
              style={styles.search}
              value={search}
              onChangeText={setSearch}
              placeholder="Search ICAO or name…"
              placeholderTextColor={theme.textFaint}
              autoCapitalize="characters"
            />

            <View style={styles.filterRow}>
              <Text style={styles.filterLabel}>Fuel</Text>
              {FUEL_OPTS.map(({ v, label }) => (
                <TouchableOpacity
                  key={v}
                  style={[styles.filterBtn, fuelFilter === v && styles.filterBtnActive]}
                  onPress={() => setFuelFilter(v)}
                >
                  <Text style={[styles.filterBtnTxt, fuelFilter === v && styles.filterBtnTxtActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.filterRow}>
              <Text style={styles.filterLabel}>Surface</Text>
              {SURF_OPTS.map(({ v, label }) => (
                <TouchableOpacity
                  key={v}
                  style={[styles.filterBtn, surfFilter === v && styles.filterBtnActive]}
                  onPress={() => setSurfFilter(v)}
                >
                  <Text style={[styles.filterBtnTxt, surfFilter === v && styles.filterBtnTxtActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.runwayRow}>
              <Text style={styles.runwayTxt}>Min runway: {minRunwayM > 0 ? `${minRunwayM} m` : 'Any'}</Text>
              <Slider
                style={{ flex: 1 }}
                minimumValue={0}
                maximumValue={2000}
                step={100}
                value={minRunwayM}
                onValueChange={setMinRunway}
                minimumTrackTintColor={theme.accentBlue}
                maximumTrackTintColor={theme.borderDefault}
                thumbTintColor={theme.accentBlue}
              />
            </View>
          </View>

          <FlatList
            data={sorted}
            keyExtractor={a => a.icao}
            renderItem={renderRow}
            style={styles.list}
            ListEmptyComponent={
              <Text style={styles.empty}>
                {aerodromes.length === 0 ? 'Loading…' : 'No aerodromes match your filters'}
              </Text>
            }
          />
        </View>
      </Modal>
    </>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  trigger: {
    width: 40, height: 40, borderRadius: theme.radiusMd,
    backgroundColor: 'rgba(19,24,36,0.90)', borderWidth: 1, borderColor: theme.borderDefault,
    alignItems: 'center', justifyContent: 'center',
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: theme.surfacePanel, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderColor: theme.borderDefault, maxHeight: '80%', paddingBottom: 8,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderDefault, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: theme.space4, paddingVertical: theme.space2,
    borderBottomWidth: 1, borderBottomColor: theme.borderSubtle,
  },
  headerTitle: { color: theme.accentBlue, fontSize: theme.textMd, fontWeight: '700' },
  glideNote: { color: '#4ade80', fontSize: 11, fontWeight: '600', flex: 1, textAlign: 'center' },
  filters: {
    paddingHorizontal: theme.space4, paddingVertical: theme.space2, gap: 6,
    borderBottomWidth: 1, borderBottomColor: theme.borderSubtle,
  },
  search: {
    borderWidth: 1, borderColor: theme.borderDefault, borderRadius: theme.radiusMd,
    paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, color: theme.textPrimary,
    backgroundColor: theme.surfaceHover,
  },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  filterLabel: { fontSize: 11, color: theme.textFaint, marginRight: 2 },
  filterBtn: {
    backgroundColor: theme.surfaceHover, borderWidth: 1, borderColor: theme.borderDefault,
    borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3,
  },
  filterBtnActive: { backgroundColor: 'rgba(59,130,246,0.18)', borderColor: theme.accentBlue },
  filterBtnTxt: { fontSize: 11, color: theme.textMuted },
  filterBtnTxtActive: { color: theme.accentBlue, fontWeight: '700' },
  runwayRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  runwayTxt: { fontSize: 11, color: theme.textFaint, minWidth: 108 },
  list: { paddingHorizontal: theme.space4 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderBottomWidth: 1, borderBottomColor: theme.borderSubtle, paddingVertical: 8,
  },
  rowHome: { borderLeftWidth: 3, borderLeftColor: '#facc15' },
  rowGlide: { backgroundColor: 'rgba(74,222,128,0.08)' },
  rowMain: { flex: 1, gap: 3 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowIcao: { fontSize: 13, fontWeight: '700', color: theme.accentBlue, minWidth: 44 },
  rowName: { fontSize: 12, color: theme.textSecondary, flex: 1 },
  rowBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowTags: { flexDirection: 'row', gap: 4, flexWrap: 'wrap', flexShrink: 1 },
  tag: {
    fontSize: 9, fontWeight: '700', color: theme.textMuted, backgroundColor: theme.surfaceHover,
    borderWidth: 1, borderColor: theme.borderDefault, paddingHorizontal: 4, borderRadius: 3,
  },
  tagHome: {
    fontSize: 9, fontWeight: '700', color: '#facc15', backgroundColor: 'rgba(250,204,21,0.12)',
    borderWidth: 1, borderColor: 'rgba(250,204,21,0.4)', paddingHorizontal: 4, borderRadius: 3,
  },
  tagGlide: {
    fontSize: 9, fontWeight: '700', color: '#4ade80', backgroundColor: 'rgba(74,222,128,0.12)',
    borderWidth: 1, borderColor: 'rgba(74,222,128,0.4)', paddingHorizontal: 4, borderRadius: 3,
  },
  tagGrass: {
    fontSize: 9, fontWeight: '700', color: '#a3e635', backgroundColor: theme.surfaceHover,
    borderWidth: 1, borderColor: theme.borderDefault, paddingHorizontal: 4, borderRadius: 3,
  },
  rowNav: { fontSize: 10, color: theme.textFaint, flexShrink: 0 },
  addBtn: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: theme.surfaceHover, borderWidth: 1, borderColor: theme.borderDefault,
  },
  empty: { color: theme.textFaint, fontSize: 12, textAlign: 'center', paddingVertical: 24 },
 } as const
}
