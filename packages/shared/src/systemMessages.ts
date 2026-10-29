/**
 * Operator notices shown in the apps (planned maintenance, degraded service,
 * outages), shared by web and native.
 *
 * The notices are a small public JSON document on a static host that does not
 * depend on the api (the api may be exactly what is down), configured per
 * build (VITE_STATUS_URL / EXPO_PUBLIC_STATUS_URL; unset = feature off). No
 * sign-in, no cookies. Everything here is defensive: a missing, broken or
 * hostile document must never break the app, so unknown fields are ignored,
 * invalid messages are dropped, and text is plain (rendered as text, never
 * HTML) and length-capped.
 *
 * Document shape (version 1):
 *   {
 *     "version": 1,
 *     "messages": [{
 *       "id": "2026-11-15-maintenance",        // stable, used for dismissal
 *       "severity": "info" | "warning" | "critical",
 *       "title": "Planned maintenance",
 *       "body": "Sign-in and sync unavailable ...",   // optional
 *       "startsAt": "2026-11-14T12:00:00Z",          // optional, ISO 8601
 *       "endsAt": "2026-11-15T07:30:00Z",            // optional
 *       "platforms": ["web", "android", "ios"],      // optional, default all
 *       "minAppVersion": "1.2.0",                    // optional (native)
 *       "maxAppVersion": "1.4.9",                    // optional (native)
 *       "url": "https://example.org/status"          // optional, https only
 *     }]
 *   }
 */

export type SystemMessageSeverity = 'info' | 'warning' | 'critical'
export type SystemMessagePlatform = 'web' | 'android' | 'ios'

export interface SystemMessage {
  id: string
  severity: SystemMessageSeverity
  title: string
  body?: string
  startsAt?: number
  endsAt?: number
  platforms?: SystemMessagePlatform[]
  minAppVersion?: string
  maxAppVersion?: string
  url?: string
}

export const SYSTEM_MESSAGE_LIMITS = { id: 100, title: 120, body: 600, url: 300, messages: 10 } as const

/** How often the apps re-fetch the document while open. */
export const SYSTEM_MESSAGES_POLL_MS = 10 * 60 * 1000

const SEVERITIES: readonly SystemMessageSeverity[] = ['info', 'warning', 'critical']
const PLATFORMS: readonly SystemMessagePlatform[] = ['web', 'android', 'ios']
const VERSION_RE = /^\d+(\.\d+){0,2}$/

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  // Collapse control characters (keep newlines in the body) and trim.
  const s = v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim()
  if (!s) return undefined
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s
}

function time(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

function parseMessage(raw: unknown): SystemMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const id = str(m['id'], SYSTEM_MESSAGE_LIMITS.id)
  const title = str(m['title'], SYSTEM_MESSAGE_LIMITS.title)
  const severity = SEVERITIES.includes(m['severity'] as SystemMessageSeverity)
    ? (m['severity'] as SystemMessageSeverity) : undefined
  if (!id || !title || !severity) return null

  const msg: SystemMessage = { id, title, severity }
  const body = str(m['body'], SYSTEM_MESSAGE_LIMITS.body)
  if (body) msg.body = body
  const startsAt = time(m['startsAt'])
  if (startsAt !== undefined) msg.startsAt = startsAt
  const endsAt = time(m['endsAt'])
  if (endsAt !== undefined) msg.endsAt = endsAt
  if (Array.isArray(m['platforms'])) {
    const platforms = m['platforms'].filter((p): p is SystemMessagePlatform => PLATFORMS.includes(p as SystemMessagePlatform))
    // A list naming no known platform targets nothing we are: drop the message.
    if (platforms.length === 0) return null
    msg.platforms = platforms
  }
  for (const key of ['minAppVersion', 'maxAppVersion'] as const) {
    const v = m[key]
    if (typeof v === 'string' && VERSION_RE.test(v.trim())) msg[key] = v.trim()
  }
  const url = str(m['url'], SYSTEM_MESSAGE_LIMITS.url)
  if (url && /^https:\/\/[^\s]+$/i.test(url)) msg.url = url
  return msg
}

/** Parse a fetched document. Anything unusable yields an empty list. */
export function parseSystemMessages(doc: unknown): SystemMessage[] {
  if (!doc || typeof doc !== 'object') return []
  const d = doc as Record<string, unknown>
  if (d['version'] !== 1 || !Array.isArray(d['messages'])) return []
  const seen = new Set<string>()
  const out: SystemMessage[] = []
  for (const raw of d['messages'].slice(0, SYSTEM_MESSAGE_LIMITS.messages * 3)) {
    const m = parseMessage(raw)
    if (!m || seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
    if (out.length >= SYSTEM_MESSAGE_LIMITS.messages) break
  }
  return out
}

/** -1 / 0 / 1 for dotted numeric versions ("1.2" == "1.2.0"). */
export function compareAppVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

const RANK: Record<SystemMessageSeverity, number> = { critical: 0, warning: 1, info: 2 }

/** Critical messages can't be dismissed: they stay until their endsAt. */
export function isDismissible(m: SystemMessage): boolean {
  return m.severity !== 'critical'
}

/**
 * Messages to show now on this platform/version, most severe first, newest
 * start first within a severity. `appVersion` unknown (web) = version limits
 * don't apply. `dismissed` = ids the user closed (critical ones ignore it).
 */
export function activeSystemMessages(messages: SystemMessage[], opts: {
  now: number
  platform: SystemMessagePlatform
  appVersion?: string | null
  dismissed?: ReadonlySet<string> | readonly string[]
}): SystemMessage[] {
  const dismissed = opts.dismissed instanceof Set ? opts.dismissed : new Set(opts.dismissed ?? [])
  return messages
    .filter(m => (m.startsAt === undefined || m.startsAt <= opts.now) && (m.endsAt === undefined || opts.now < m.endsAt))
    .filter(m => !m.platforms || m.platforms.includes(opts.platform))
    .filter(m => {
      if (!opts.appVersion) return true
      if (m.minAppVersion && compareAppVersions(opts.appVersion, m.minAppVersion) < 0) return false
      if (m.maxAppVersion && compareAppVersions(opts.appVersion, m.maxAppVersion) > 0) return false
      return true
    })
    .filter(m => !isDismissible(m) || !dismissed.has(m.id))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.startsAt ?? 0) - (a.startsAt ?? 0))
}

/** Drop dismissed ids that no longer exist in the document (keeps storage small). */
export function pruneDismissed(dismissed: readonly string[], messages: SystemMessage[]): string[] {
  const ids = new Set(messages.map(m => m.id))
  return dismissed.filter(id => ids.has(id))
}

/**
 * Fetch and parse the document. Never throws: network errors, non-2xx, bad
 * JSON all return null, so callers keep their last good copy.
 */
export async function fetchSystemMessages(url: string, timeoutMs = 8000): Promise<SystemMessage[] | null> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const res = await fetch(url, { cache: 'no-cache', credentials: 'omit', signal: ctrl?.signal })
    if (!res.ok) return null
    return parseSystemMessages(await res.json())
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
