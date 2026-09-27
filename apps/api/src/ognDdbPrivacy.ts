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

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Canonical URL WITH trailing slash: the non-slash form 301s to this, and
// the DDB's per-IP rate limiter counts both hops -- every attempt cost two
// requests and tripped its burst limit after a couple of container restarts
// (confirmed live: persistent 429s for 10+ minutes after a deploy).
const DDB_DOWNLOAD_URL = 'https://ddb.glidernet.org/download/'

/**
 * On-disk copy of the last successfully fetched opt-out set, so a restart
 * is privacy-correct immediately without a network round-trip (and without
 * spending DDB rate-limit budget at all). Same /data mount as the NOTAM
 * cache; default matches docker-compose.prod.yml's api volume.
 */
const DDB_CACHE_FILE = process.env['DDB_CACHE_FILE'] || '/data/ogn-ddb-optout.json'

/** Refresh the opt-out list once a day — device opt-out status changes rarely, no need to poll more often. */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Retry schedule while we have NO successful fetch yet. Until the first
 * success, isTrackingOptedOut() fails open (every device shown), so a
 * failed boot fetch -- e.g. a 429 from the DDB after two container starts
 * in quick succession, seen live on a deploy -- must NOT wait a full day
 * to retry: that would show opted-out gliders for up to 24h. Backs off
 * from 5 min up to 1 h (the DDB's limiter is strict; hammering it only
 * extends the ban). Only reached when there is no on-disk cache either.
 */
const RETRY_MIN_MS = 5 * 60 * 1000
const RETRY_MAX_MS = 60 * 60 * 1000

/** Set of uppercase 6-hex device IDs with tracked=N in the DDB. Empty until the first successful fetch. */
let _optedOut = new Set<string>()
let _refreshTimer: ReturnType<typeof setInterval> | null = null
let _retryDelayMs = RETRY_MIN_MS
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

async function refresh(): Promise<boolean> {
  try {
    const res = await fetch(DDB_DOWNLOAD_URL)
    if (!res.ok) {
      console.error(`[ogn-ddb] Download failed: ${res.status}`)
      return false
    }
    const text = await res.text()
    const optedOut = parseDdbCsv(text)
    _optedOut = optedOut
    _fetchedOnce = true
    console.log(`[ogn-ddb] Loaded ${optedOut.size} tracking-opt-out device IDs`)
    saveCache(optedOut)
    return true
  } catch (err) {
    console.error('[ogn-ddb] Fetch error:', err instanceof Error ? err.message : String(err))
    return false
  }
}

function saveCache(optedOut: Set<string>): void {
  try {
    mkdirSync(dirname(DDB_CACHE_FILE), { recursive: true })
    const tmp = `${DDB_CACHE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), optedOut: [...optedOut] }))
    renameSync(tmp, DDB_CACHE_FILE)  // atomic: never leave a half-written cache
  } catch (err) {
    console.warn('[ogn-ddb] Could not persist cache:', err instanceof Error ? err.message : String(err))
  }
}

/** Returns true if a previously saved list was loaded. Any parse/read failure is treated as "no cache". */
function loadCache(): boolean {
  try {
    const raw = JSON.parse(readFileSync(DDB_CACHE_FILE, 'utf8')) as { savedAt?: string; optedOut?: unknown }
    if (!Array.isArray(raw.optedOut)) return false
    _optedOut = new Set(raw.optedOut.filter((x): x is string => typeof x === 'string'))
    _fetchedOnce = true
    console.log(`[ogn-ddb] Loaded ${_optedOut.size} tracking-opt-out device IDs from disk (saved ${raw.savedAt ?? 'unknown'})`)
    return true
  } catch {
    return false
  }
}

/** Boot-time fetch with backoff until the first success; the daily refresh takes over after that. */
async function refreshUntilFirstSuccess(): Promise<void> {
  if (await refresh()) return
  console.warn(`[ogn-ddb] No opt-out list yet (failing open) -- retrying in ${Math.round(_retryDelayMs / 1000)}s`)
  setTimeout(() => { void refreshUntilFirstSuccess() }, _retryDelayMs)
  _retryDelayMs = Math.min(_retryDelayMs * 2, RETRY_MAX_MS)
}

/**
 * Called once at server boot. Fetches the DDB immediately (best-effort —
 * failure just means the opt-out set stays empty until the next successful
 * refresh) and schedules a daily refresh.
 */
export function startDdbPrivacyRefresh(): void {
  if (_refreshTimer) return
  if (loadCache()) {
    // Privacy-correct from the cached list already; a plain refresh (no
    // retry loop) is enough -- if it 429s, the daily timer tries again.
    void refresh()
  } else {
    void refreshUntilFirstSuccess()
  }
  // A daily refresh that fails just keeps the previous (still valid) list;
  // only a cold start with no cache needs the retry loop above.
  _refreshTimer = setInterval(() => { void refresh() }, REFRESH_INTERVAL_MS)
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
