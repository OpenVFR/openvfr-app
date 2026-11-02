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

/** ICAO ADS-B emitter categories (the numbers both feeds use) as shown to the pilot. */
export const TRAFFIC_CATEGORY_LABEL: Readonly<Record<number, string>> = {
  0: 'No info', 1: 'Light', 2: 'Small', 3: 'Large', 4: 'B757-class',
  5: 'Heavy', 6: 'High-perf', 7: 'Rotorcraft', 8: 'Glider',
  9: 'Lighter-than-air', 10: 'Parachutist', 11: 'Ultralight',
  12: 'Ultralight', 13: 'UAV', 14: 'Space vehicle',
}

/**
 * How the target was tracked: 'FLARM' for FLARM / OGN-tracker devices (their
 * ids are namespaced `ogn-` by the api), 'ADS-B' for an ICAO address --
 * including ADS-B that an OGN ground station relayed, which arrives with
 * source 'ogn' but is still a transponder.
 */
export function trafficDeviceLabel(icao24: string): 'FLARM' | 'ADS-B' {
  return icao24.startsWith('ogn-') ? 'FLARM' : 'ADS-B'
}

/** The network the position came from, for attribution. */
export function trafficNetworkLabel(source: 'opensky' | 'ogn' | string | undefined): string {
  return source === 'ogn' ? 'Open Glider Network' : 'OpenSky Network'
}
