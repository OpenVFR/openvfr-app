/**
 * The lakes that matter for the glide-to-land check. A glide of a few NM can
 * only fail to reach a shore on a lake wider than about twice that, so ponds
 * and small lakes never change the answer: keeping only the large ones turns
 * a nationwide water dataset (tens of thousands of polygons, ~100 MB parsed)
 * into a few dozen polygons. Area is the polygon's outer rings minus its
 * holes, from degrees at the polygon's own latitude (good to a few percent).
 */
type Poly = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>

/** Lakes smaller than this (km²) are left out. Generous: a lake must be well over 100 km² to be 13 NM across. */
export const MIN_GLIDE_LAKE_KM2 = 50

function ringKm2(r: readonly number[][]): number {
  let a = 0, lat = 0
  for (let i = 0; i < r.length - 1; i++) {
    a += r[i]![0]! * r[i + 1]![1]! - r[i + 1]![0]! * r[i]![1]!
    lat += r[i]![1]!
  }
  const midLat = r.length > 1 ? lat / (r.length - 1) : 0
  return (Math.abs(a) / 2) * 111.32 * 111.32 * Math.cos((midLat * Math.PI) / 180)
}

export function lakeAreaKm2(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): number {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
  let total = 0
  for (const p of polys) {
    p.forEach((ring, i) => { total += (i === 0 ? 1 : -1) * ringKm2(ring) })
  }
  return total
}

export function largeLakes(fc: GeoJSON.FeatureCollection, minKm2 = MIN_GLIDE_LAKE_KM2): GeoJSON.FeatureCollection {
  const features = fc.features.filter((f): f is Poly => !!f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') && lakeAreaKm2(f.geometry) >= minKm2)
  return { type: 'FeatureCollection', features }
}
