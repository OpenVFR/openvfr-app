/**
 * Local data belongs to one account at a time.
 *
 * The browser database (routes, aircraft, waypoints, flight logs) is shared by
 * whoever uses this browser profile, and useSync uploads every local document
 * on sign-in. Without a boundary, signing in as a second account uploaded the
 * first account's private data into it.
 *
 *  - `openvfr.syncOwner` records the account the local data was synced for.
 *  - Sign-out flags a wipe (`openvfr.wipePending`); useSync performs it once
 *    the push subscriptions are gone (deleting documents while they are live
 *    would push DELETEs to the cloud copy).
 *  - Signing in as a different account than the owner wipes before any pull
 *    or push. Data created while signed out (no owner) is kept and uploaded
 *    to the first account that signs in, as before.
 *
 * Settings are per-device (units, layers, ...) and are not wiped.
 */

import { getDb } from './index'

const OWNER_KEY = 'openvfr.syncOwner'
const WIPE_KEY  = 'openvfr.wipePending'
const LAST_SYNC_KEY = 'openvfr.sync.lastSyncAt'

export const getSyncOwner = (): string | null => localStorage.getItem(OWNER_KEY)
export const setSyncOwner = (userId: string): void => localStorage.setItem(OWNER_KEY, userId)
export const flagWipeOnSignOut = (): void => localStorage.setItem(WIPE_KEY, '1')
export const isWipePending = (): boolean => localStorage.getItem(WIPE_KEY) === '1'

/** Remove the previous account's private local data. Caller must ensure no
 *  sync subscription is active. */
export async function clearPrivateLocalData(): Promise<void> {
  const db = await getDb()
  for (const col of [db.routes, db.aircraft_profiles, db.user_waypoints, db.flight_logs]) {
    const docs = await col.find().exec()
    if (docs.length) await col.bulkRemove(docs.map((d) => d.primary))
  }
  localStorage.removeItem(OWNER_KEY)
  localStorage.removeItem(WIPE_KEY)
  localStorage.removeItem(LAST_SYNC_KEY)
}
