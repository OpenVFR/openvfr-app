/**
 * syncMeta — per-device "last successful sync round" high-water mark.
 *
 * Cross-device delete race this solves: Device A deletes a row and pushes
 * DELETE to the server. Device B still has its own local (undeleted) copy
 * from before that reached it. When Device B's next sync pull() runs, its
 * "push anything local the server doesn't have" step sees the row missing
 * server-side and — with no way to tell "deleted elsewhere" apart from
 * "never uploaded yet" — re-uploads it, resurrecting it everywhere on the
 * next pull. This is exactly how a delete on one device "undoes itself".
 *
 * Fix: each sync hook stamps this timestamp after a full pull+reconcile
 * round. On the next round, a local doc missing from the server is only
 * re-pushed if it was modified after the last stamp (i.e. genuinely new/
 * edited since we last synced); otherwise it's deleted locally instead of
 * resurrected. Deliberately device-local only — never synced itself.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = 'ovfr:sync_last_at'

// In-memory cache avoids an AsyncStorage round-trip on every sync call within
// the same app session; still persisted so it survives app restarts.
let cached: number | null = null

export async function getLastSyncAt(): Promise<number> {
  if (cached !== null) return cached
  try {
    const raw = await AsyncStorage.getItem(KEY)
    cached = raw ? Number(raw) : 0
  } catch {
    cached = 0
  }
  return cached
}

export async function setLastSyncAt(ts: number): Promise<void> {
  cached = ts
  try { await AsyncStorage.setItem(KEY, String(ts)) } catch { /* ignore */ }
}
