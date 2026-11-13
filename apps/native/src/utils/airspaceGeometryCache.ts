/**
 * Thin re-export wrapper around @open-vfr/shared/airspaceGeometryCache,
 * pre-binding the (versioned) airspace tile URL so existing native call sites don't
 * need to pass it. See the shared module for the full explanation.
 */

import { getFullRing as sharedGetFullRing } from '@open-vfr/shared/airspaceGeometryCache'
import { tileUrlReady } from '../config'

export async function getFullRing(
  props: { name?: string; lower_ft?: number; upper_ft?: number },
  clippedCoords?: number[][],
): Promise<number[][] | undefined> {
  return sharedGetFullRing(props, await tileUrlReady('airspace'), clippedCoords)
}
