/**
 * StatusScrim — faint band under the status bar so its icons stay legible on
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

import React from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import { ReservedRegionsProvider, useReservedRegions } from 'react-native-reserved-regions'

const COLOR = 'rgba(10,14,22,0.35)'

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
            borderBottomLeftRadius: r.frame.x > 0 ? 16 : 0,
            borderBottomRightRadius: r.frame.x + r.frame.width < width ? 16 : 0,
          }]}
        />
      ))}
    </>
  )
}

export function StatusScrim({ height }: { height: number }) {
  if (height <= 0) return null
  return (
    <ReservedRegionsProvider pointerEvents="none" style={styles.provider}>
      <Band height={height} />
    </ReservedRegionsProvider>
  )
}

const styles = StyleSheet.create({
  provider: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 60 },
  full:     { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: COLOR },
  region:   { position: 'absolute', top: 0, backgroundColor: COLOR },
})
