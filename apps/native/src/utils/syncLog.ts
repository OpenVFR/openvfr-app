/**
 * syncLog — small in-memory ring buffer of sync diagnostics, viewable from
 * Settings → About → Diagnostics. Lets users/testers on release builds report
 * why cloud sync fails without a debugger. Never persisted; never contains
 * tokens (only HTTP status, response body and short messages).
 */

const MAX = 60
const entries: string[] = []

export function syncLog(...args: unknown[]): void {
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  entries.push(`${new Date().toISOString().slice(11, 19)} ${msg.slice(0, 400)}`)
  if (entries.length > MAX) entries.shift()
  console.warn(msg)
}

export function getSyncLog(): string {
  return entries.length ? entries.join('\n') : '(no sync events yet)'
}
