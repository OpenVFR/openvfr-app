/**
 * quickDistNm: flat-earth distance in NM between two nearby points (one
 * degree of latitude = 60 NM, longitude scaled by the mean latitude's
 * cosine). For short hops between consecutive GPS fixes and throttle /
 * staleness checks, not for route legs (use a great-circle formula there).
 */
export function quickDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * 60
  const dLng = (lng2 - lng1) * 60 * Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}
