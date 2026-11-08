/**
 * Where the system reserves part of the display (iPhone Duo, iOS 27.1+): the
 * status bar with its Dynamic Island, the camera, the fold. UIKit reports them
 * as frames ("reserved regions"); the native app reads them with
 * react-native-reserved-regions. Pure helpers, so the layout rules are testable.
 */

export interface RegionFrame { x: number; y: number; width: number; height: number }
export interface ReservedRegionLike { kind: 'division' | 'occlusion'; frame: RegionFrame }

/**
 * The lowest bottom edge (pt from the top) among occlusions that overlap the
 * horizontal span [x0, x1] and start within the first `topZone` points: the
 * y at which a column of controls pinned to the top of that span clears the
 * status block and any camera cut-out in its way. 0 when nothing is in the way.
 *
 * Occlusions further down (a camera mid-screen in some pose) are not the top
 * controls' business, hence `topZone`.
 */
export function occlusionBottomOver(
  regions: readonly ReservedRegionLike[], x0: number, x1: number, topZone: number,
): number {
  let bottom = 0
  for (const r of regions) {
    if (r.kind !== 'occlusion') continue
    const { x, y, width, height } = r.frame
    if (x + width <= x0 || x >= x1) continue   // beside the span
    if (y >= topZone) continue                 // not at the top
    bottom = Math.max(bottom, y + height)
  }
  return bottom
}
