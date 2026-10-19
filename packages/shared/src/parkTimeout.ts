/**
 * Flight-log "split timeout" (park timeout): how long the aircraft may stay on
 * the ground after landing before the log is closed. Taking off again within
 * the timeout continues the same log, so circuits and quick turnarounds stay
 * one entry. 0 = close at every landing (one log per leg / touch-and-go).
 * Shared by web and native.
 */
export const PARK_TIMEOUT_OPTIONS = [0, 60, 120, 300, 600, 1800] as const
export type ParkTimeoutOption = typeof PARK_TIMEOUT_OPTIONS[number]
export const PARK_TIMEOUT_DEFAULT: ParkTimeoutOption = 300

/** Coerce a stored value to a valid option, else the default. */
export function parseParkTimeout(raw: unknown): ParkTimeoutOption {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : raw
  return (PARK_TIMEOUT_OPTIONS as readonly unknown[]).includes(n) ? (n as ParkTimeoutOption) : PARK_TIMEOUT_DEFAULT
}

/** Short label: "Per leg", "1 min", "30 min". */
export function parkTimeoutLabel(v: ParkTimeoutOption): string {
  return v === 0 ? 'Per leg' : `${v / 60} min`
}
