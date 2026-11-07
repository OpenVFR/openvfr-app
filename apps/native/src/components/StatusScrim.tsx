/**
 * StatusScrim — faint downward-fading band under the status bar so its icons stay legible on
 * a light map that runs underneath it.
 *
 * On a regular iPhone the band spans the full width of the top inset. On
 * iPhone Duo (iOS 27.1) the status bar is a compact block in the top-right
 * corner while the top inset is 82 pt over the whole width, so a full-width
 * band left a large empty grey strip. There UIKit reports the status area as
 * a reserved "occlusion" region touching the top edge, and the band is drawn
 * only behind that region. The camera occlusion (below the top edge) and
 * Android cutouts don't match, so everything else keeps the full-width band.
 */

import React, { memo } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import { ReservedRegionsProvider, useReservedRegions } from 'react-native-reserved-regions'

// Dark at the top edge, clear at the bottom: the status icons stay legible
// without a visible band edge across the map.
const GRADIENT = 'linear-gradient(to bottom, rgba(10,14,22,0.45), rgba(10,14,22,0.25) 60%, rgba(10,14,22,0))'
// The Duo's status block sits in the top-right corner: fade towards the map
// on both of its open sides.
const CORNER_GRADIENT = 'linear-gradient(to bottom left, rgba(10,14,22,0.5), rgba(10,14,22,0.25) 55%, rgba(10,14,22,0))'

function Band({ height }: { height: number }) {
  const { width } = useWindowDimensions()
  const status = useReservedRegions().filter(r =>
    r.kind === 'occlusion'
    && r.frame.y <= 1
    && r.frame.height >= height - 2
    && r.frame.width < width * 0.8,
  )
  if (status.length === 0) {
    return <View style={[styles.full, { height }]} />
  }
  return (
    <>
      {status.map((r, i) => (
        <View
          key={i}
          style={[styles.region, {
            left: r.frame.x, width: r.frame.width, height: r.frame.height,
          }]}
        />
      ))}
    </>
  )
}

// Memoised: MapScreen re-renders on every GPS tick and the only prop is a number.
export const StatusScrim = memo(function StatusScrim({ height }: { height: number }) {
  if (height <= 0) return null
  return (
    <ReservedRegionsProvider pointerEvents="none" style={styles.provider}>
      <Band height={height} />
    </ReservedRegionsProvider>
  )
})

const styles = StyleSheet.create({
  provider: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 60 },
  full:     { position: 'absolute', top: 0, left: 0, right: 0, backgroundImage: GRADIENT },
  region:   { position: 'absolute', top: 0, backgroundImage: CORNER_GRADIENT },
})
