import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  activeSystemMessages, parseSystemMessages, pruneDismissed,
  SYSTEM_MESSAGES_POLL_MS, type SystemMessage,
} from '@open-vfr/shared/systemMessages'
import { STATUS_URL } from '../utils/env'

const CACHE_KEY = 'ovfr:systemMessages:doc'
const DISMISSED_KEY = 'ovfr:systemMessages:dismissed'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

/**
 * Operator notices (VITE_STATUS_URL). Fetched at start, every 10 min, and
 * when the tab becomes visible again; the last good copy is kept in
 * localStorage so a notice stays visible offline or while the host is
 * unreachable. Never throws, never blocks the app.
 */
export function useSystemMessages() {
  const [messages, setMessages] = useState<SystemMessage[]>(() =>
    STATUS_URL ? parseSystemMessages(readJson<unknown>(CACHE_KEY, null)) : [])
  const [dismissed, setDismissed] = useState<string[]>(() => readJson<string[]>(DISMISSED_KEY, []))
  // Re-evaluate time windows even when nothing is re-fetched.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!STATUS_URL) return
    let cancelled = false
    const load = async () => {
      setNow(Date.now())
      const res = await fetch(STATUS_URL, { cache: 'no-cache', credentials: 'omit' })
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)
      if (cancelled || res === null) return
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(res)) } catch { /* quota/private mode */ }
      setMessages(parseSystemMessages(res))
    }
    void load()
    const id = setInterval(() => { void load() }, SYSTEM_MESSAGES_POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  // Keep only dismissals of messages that still exist.
  useEffect(() => {
    if (messages.length === 0) return
    const pruned = pruneDismissed(dismissed, messages)
    if (pruned.length !== dismissed.length) {
      setDismissed(pruned)
      try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(pruned)) } catch { /* ignore */ }
    }
  }, [messages, dismissed])

  const active = useMemo(
    () => activeSystemMessages(messages, { now, platform: 'web', dismissed }),
    [messages, now, dismissed],
  )

  const dismiss = useCallback((id: string) => {
    setDismissed(prev => {
      const next = prev.includes(id) ? prev : [...prev, id]
      try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  return { active, dismiss }
}
