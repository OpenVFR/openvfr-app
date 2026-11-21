/**
 * The map camera as the last region change reported it (centre, zoom, bearing, pitch). The details layers read it to move reporting points clear of
 * landmark and obstacle symbols (packages/shared symbolDeclutter); a store, so a camera move does not re-render the whole map component.
 */
import { createValueStore, useStoreValue } from './valueStore'

export interface CameraView { lon: number; lat: number; zoom: number; bearing: number; pitch: number }

const store = createValueStore<CameraView | null>(null)

export function setCameraView(v: CameraView): void {
  const c = store.get()
  // zoom to 0.05, position to about a metre at close zoom: a burst of near-identical frames is one update
  if (c && Math.abs(c.zoom - v.zoom) < 0.05 && Math.abs(c.bearing - v.bearing) < 1 && Math.abs(c.lon - v.lon) < 2e-5 && Math.abs(c.lat - v.lat) < 2e-5) return
  store.set(v)
}

export const useCameraView = (): CameraView | null => useStoreValue(store)
