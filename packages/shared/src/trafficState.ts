/**
 * trafficState: how web and native read the server's traffic states
 * (apps/api/src/traffic.ts TrafficState) for ground detection and
 * altitude. Shared so both apps show the same targets.
 */

/**
 * Above this ground speed a target reported "on ground" is treated as
 * airborne. Portable ADS-B out units in ultralights and gyroplanes have no
 * weight-on-wheels switch and guess air/ground from speed; slow flyers are
 * then reported on the ground the whole flight. No taxiing aircraft goes
 * this fast, and a take-off or landing roll shown as airborne is harmless.
 */
export const TRAFFIC_GROUND_MAX_KT = 30

/** True when a target should be drawn and handled as being on the ground. */
export function trafficOnGround(reportedOnGround: boolean, speedKts: number | null): boolean {
  return reportedOnGround && (speedKts ?? 0) < TRAFFIC_GROUND_MAX_KT
}

/**
 * Altitude (metres) to compare with own GPS altitude: GNSS when known,
 * else pressure altitude. Pressure altitude is relative to 1013.25 hPa and
 * reads ~30 ft low per hPa of higher QNH, so low traffic near the coast on
 * a high-pressure day comes out below 0. Never derive "on the ground" from
 * it.
 */
export function trafficAltitudeM(baroM: number | null, geoM: number | null | undefined): number | null {
  return geoM ?? baroM
}
