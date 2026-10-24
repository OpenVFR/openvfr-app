/**
 * Pauses cloud-sync change capture while local data is wiped (sign-out,
 * account switch). Those removals are not user deletes and must never be
 * queued as server deletes. Separate module so db/userScope.ts and
 * sync/cloudSync.ts can both use it without importing each other.
 */

let paused = 0

export function captureIsPaused(): boolean {
  return paused > 0
}

/** Run `fn` with change capture paused. */
export async function withoutChangeCapture<T>(fn: () => Promise<T>): Promise<T> {
  paused++
  try {
    return await fn()
  } finally {
    // RxDB change events arrive asynchronously after the write resolves;
    // keep the gate closed until they have been delivered.
    await new Promise(r => setTimeout(r, 0))
    paused--
  }
}
