/**
 * The base layer's reporting points with the VFR ones (RP) moved beside the landmark and obstacle symbols they would sit on (packages/shared symbolDeclutter);
 * mandatory reporting points and holding points are never moved. Published by a headless component next to the map; the waypoint layer reads it, so a camera move
 * re-renders the map only when the placement actually changes.
 */
import { createValueStore, useStoreValue } from './valueStore'

const store = createValueStore<GeoJSON.FeatureCollection | null>(null)

export const setDisplacedWaypoints = (fc: GeoJSON.FeatureCollection | null): void => store.set(fc)
export const useDisplacedWaypoints = (): GeoJSON.FeatureCollection | null => useStoreValue(store)
