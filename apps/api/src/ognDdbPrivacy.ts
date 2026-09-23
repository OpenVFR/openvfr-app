/**
 * server/src/ognDdbPrivacy.ts
 *
 * OGN Devices Database (DDB) tracking-opt-out filter.
 *
 * OGN's data usage rules (https://www.glidernet.org/ogn-data-usage/) require
 * anyone consuming OGN data to "follow DDB tracking privacy choices" as a
 * condition of the ODbL license. A pilot can register their device in
 * https://ddb.glidernet.org and set `tracked=N` — that's a SEPARATE
 * mechanism from FLARM's own "no-tracking" bit in the APRS id field:
 *
 *   - no-tracking bit (see ognTraffic.ts's ID_RE/noTrack handling): rejected
 *     by the OGN ground receiver itself, never reaches APRS-IS at all. Any
 *     packet we receive has already passed this filter — nothing to do here.
 *   - DDB tracked=N: the packet DOES still reach APRS-IS (OGN's own ground
 *     network can't distinguish it from a tracked device at the RF level),
 *     but the pilot has separately registered their device ID as "please
 *     don't show my live position downstream". This is the opt-out THIS
 *     module implements — periodically download the DDB's public CSV,
 *     build a set of opted-out device IDs, and filter their positions out
 *     of the merged traffic batch before it ever reaches a client.
 *
 * `identified=N` (also in the DDB) is not handled here — this app never
 * enriches OGN targets with DDB registration/aircraft-model data in the
 * first place, so there's nothing to withhold beyond the raw APRS
 * callsign, which OGN's own ground network already anonymizes (random
 * underscore-prefixed daily callsign) for any non-opted-in device.
 */

const DDB_DOWNLOAD_URL = 'http://ddb.glidernet.org/download'

/** Refresh the opt-out list once a day — device opt-out status changes rarely, no need to poll more often. */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Set of uppercase 6-hex device IDs with tracked=N in the DDB. Empty until the first successful fetch. */
let _optedOut = new Set<string>()
let _refreshTimer: ReturnType<typeof setInterval> | null = null
let _fetchedOnce = false

/**
 * CSV-ish format, single-quoted fields, `#`-prefixed comment lines:
 *   'F','DDA5BA','TypeName','Registration','CN','Y','Y','1'
 * Columns: device_type, device_id, aircraft_model, registration, cn, tracked, identified, aircraft_type
 */
function parseDdbCsv(text: string): Set<string> {
  const optedOut = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const fields = trimmed.split(',').map(f => f.replace(/^'|'$/g, ''))
    const deviceId = fields[1]
    const tracked = fields[5]
    if (deviceId && tracked === 'N') optedOut.add(deviceId.toUpperCase())
  }
  return optedOut
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch(DDB_DOWNLOAD_URL)
    if (!res.ok) {
      console.error(`[ogn-ddb] Download failed: ${res.status}`)
      return
    }
    const text = await res.text()
    const optedOut = parseDdbCsv(text)
    _optedOut = optedOut
    _fetchedOnce = true
    console.log(`[ogn-ddb] Loaded ${optedOut.size} tracking-opt-out device IDs`)
  } catch (err) {
    console.error('[ogn-ddb] Fetch error:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Called once at server boot. Fetches the DDB immediately (best-effort —
 * failure just means the opt-out set stays empty until the next successful
 * refresh) and schedules a daily refresh.
 */
export function startDdbPrivacyRefresh(): void {
  refresh()
  if (_refreshTimer) return
  _refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS)
}

/**
 * True if this 6-hex device ID (uppercase or lowercase) has opted out of
 * tracking via the DDB. ognTraffic.ts checks this before calling
 * updateOgnState() so an opted-out device's position never enters the
 * merged batch in the first place.
 *
 * Before the first successful DDB fetch completes, this always returns
 * false (fail-open on the DDB call itself, not on user privacy — the
 * no-tracking APRS bit is still enforced upstream by OGN's own ground
 * receivers regardless of whether this module has loaded yet).
 */
export function isTrackingOptedOut(deviceIdHex: string): boolean {
  if (!_fetchedOnce) return false
  return _optedOut.has(deviceIdHex.toUpperCase())
}
