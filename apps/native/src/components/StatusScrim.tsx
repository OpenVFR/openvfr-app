/**
 * StatusScrim — faint downward-fading band under the status bar so its icons stay legible on
 * a light map that runs underneath it.
 *
 * On a regular iPhone the band spans the full width of the top inset. On
 * iPhone Duo (iOS 27.1) the status bar is a compact block in the top-right
 * corner that the system already backs with its own box; UIKit reports it as
 * a reserved "occlusion" region touching the top edge, and no scrim is drawn
 * there. The camera occlusion (below the top edge) and Android cutouts don't
 * match, so everything else keeps the full-width band.
 */

import React, { memo } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import { useReservedRegions } from 'react-native-reserved-regions'
import { statusBlockRegion } from '@open-vfr/shared/reservedRegions'

// Dark at the top edge, clear at the bottom: the status icons stay legible
// without a visible band edge across the map.
const GRADIENT = 'linear-gradient(to bottom, rgba(10,14,22,0.45), rgba(10,14,22,0.25) 60%, rgba(10,14,22,0))'

function Band({ height }: { height: number }) {
  const { width } = useWindowDimensions()
  const block = statusBlockRegion(useReservedRegions(), height, width)
  // iPhone Duo: the system already draws its own backdrop behind the status
  // block; a second scrim on top of it looks like a doubled box.
  if (block) return null
  return <View style={[styles.full, { height }]} />
}

// Memoised: MapScreen re-renders on every GPS tick and the only prop is a number.
export const StatusScrim = memo(function StatusScrim({ height }: { height: number }) {
  if (height <= 0) return null
  // Needs a ReservedRegionsProvider above it (MapScreen's).
  return (
    <View pointerEvents="none" style={styles.provider}>
      <Band height={height} />
    </View>
  )
})

const styles = StyleSheet.create({
  provider: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 60 },
  full:     { position: 'absolute', top: 0, left: 0, right: 0, backgroundImage: GRADIENT },
})
