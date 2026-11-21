/**
 * Numbers the pilot reads (altitudes, speeds, distances, frequencies, masses): one fixed format on every device.
 *
 * `n.toLocaleString()` with no locale follows the phone or browser, so the same 1300 ft reads "1,300", "1.300" or "1 300" depending on
 * the device, and a flight crew comparing two screens can read two different altitudes. Aviation numbers go through here instead:
 * digit grouping with a comma, a dot for decimals, never the device's choice. (A number that is not an aviation value, such as a date,
 * is outside this: keep the device's locale there.)
 */

/** `1300` -> "1,300"; the same on every device. Up to three decimals, like the default format it replaces. */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}
