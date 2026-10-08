/**
 * MapInfoBar (native) -- bottom-right map status pill, same content as web's
 * MapInfoBar: info (i) button, active airspace altitude band, scale bar and
 * representative-fraction scale (1:N).
 *
 * The camera is pushed in imperatively via the ref (`setCamera`) instead of
 * lifting it into AviationMap state: region-change events arrive at display
 * rate during a pan, and a state update in AviationMap re-renders the whole
 * map. Here only this small pill re-renders, and only when the rounded scale
 * actually changes.
 */
import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import { computeMapScale } from '@open-vfr/shared/mapScale'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'
import { MAX_FT, ftToLabel } from './AltitudeSlider'

const MAX_BAR_DP = 60
const MIN_UPDATE_MS = 100

export interface MapInfoBarHandle {
  setCamera: (lat: number, zoom: number) => void
}

interface Props {
  ceilingFt:    number
  distanceUnit: 'nm' | 'km'
  initialCamera: { lat: number; zoom: number }
  onInfoPress:  () => void
  /** Altitude the wind arrows show, e.g. "WIND 4,500 ft PLAN"; omit when the layer is off. */
  windLabel?:   string
}

export const MapInfoBar = forwardRef<MapInfoBarHandle, Props>(function MapInfoBar(
  { ceilingFt, distanceUnit, initialCamera, onInfoPress, windLabel }, ref,
) {
  const styles = useThemedStyles(makeStyles)
  const [cam, setCam] = useState(initialCamera)
  const lastAtRef = useRef(0)
  const lastKeyRef = useRef('')

  useImperativeHandle(ref, () => ({
    setCamera: (lat, zoom) => {
      const key = `${lat.toFixed(1)},${zoom.toFixed(2)}`
      const now = Date.now()
      if (key === lastKeyRef.current || now - lastAtRef.current < MIN_UPDATE_MS) return
      lastKeyRef.current = key
      lastAtRef.current = now
      setCam({ lat, zoom })
    },
  }), [])

  const scale = useMemo(
    () => computeMapScale(cam.lat, cam.zoom, distanceUnit === 'nm', MAX_BAR_DP),
    [cam, distanceUnit],
  )
  const unlimited = ceilingFt >= MAX_FT
  const altLabel = `SFC \u2013 ${unlimited ? 'UNL' : ftToLabel(ceilingFt)}`

  return (
    <View style={styles.bar} pointerEvents="box-none">
      <TouchableOpacity
        style={styles.infoBtn}
        onPress={onInfoPress}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel="Map data & attribution"
        testID="map-info-button"
      >
        <Text style={styles.infoText}>i</Text>
      </TouchableOpacity>
      <Text style={[styles.alt, !unlimited && styles.altFiltered]} testID="map-altitude-filter">{altLabel}</Text>
      {windLabel ? <Text style={styles.alt} testID="map-wind-altitude">{windLabel}</Text> : null}
      <View style={styles.scale} pointerEvents="none">
        <View style={[styles.scaleBar, { width: scale.barPx }]} />
        <Text style={styles.scaleLabel}>{scale.label}</Text>
      </View>
      <Text style={styles.ratio} pointerEvents="none">{scale.ratio}</Text>
    </View>
  )
})

const makeStyles = (t: ScaledTheme) => ({
  bar: {
    position: 'absolute' as const,
    right: 8,
    bottom: 8,
    zIndex: 20,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 7,
    paddingVertical: 2,
    paddingLeft: 4,
    paddingRight: 8,
    borderRadius: 6,
    backgroundColor: t.surfacePanel,
    borderWidth: 1,
    borderColor: t.borderStrong,
  },
  infoBtn: {
    width: 16, height: 16, borderRadius: 8,
    alignItems: 'center' as const, justifyContent: 'center' as const,
  },
  infoText: { color: t.textMuted, fontSize: 11, fontWeight: '700' as const, fontStyle: 'italic' as const },
  alt: { color: t.textSecondary, fontSize: t.scale(9), fontWeight: '600' as const },
  altFiltered: { color: t.accentYellow },
  scale: { alignItems: 'center' as const, gap: 1 },
  scaleBar: {
    height: 3,
    borderWidth: 1,
    borderColor: t.textPrimary,
    borderTopWidth: 0,
  },
  scaleLabel: { color: t.textMuted, fontSize: t.scale(7), fontWeight: '500' as const },
  ratio: { color: t.textSecondary, fontSize: t.scale(9), fontWeight: '600' as const },
})
