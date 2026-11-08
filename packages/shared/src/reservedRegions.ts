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

/**
 * The compact status block of iPhone Duo (iOS 27.1): one occlusion in a
 * corner of the top edge, as tall as the top inset and well short of the full
 * width, so the rest of the top strip is free. null on every other device
 * (regular phones draw status text across the whole top strip) and when the
 * system reports nothing.
 */
export function statusBlockRegion(
  regions: readonly ReservedRegionLike[], topInset: number, windowWidth: number,
): RegionFrame | null {
  if (topInset <= 0) return null
  for (const r of regions) {
    if (r.kind !== 'occlusion') continue
    const f = r.frame
    if (f.y <= 1 && f.height >= topInset - 2 && f.width < windowWidth * 0.8) return f
  }
  return null
}
