/**
 * Operator notices (planned maintenance, degraded service, outages) from
 * STATUS_URL (config.ts), shown on every screen including sign-in.
 *
 * Fetched at start, when the app returns to the foreground and every 10 min.
 * The last good document is kept in AsyncStorage, so a notice stays visible
 * offline or while its host is unreachable. Dismissals are stored per message
 * id; critical messages can't be dismissed. Plain text only.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AppState, Linking, Platform, Text, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Application from 'expo-application'
import {
  activeSystemMessages, isDismissible, parseSystemMessages, pruneDismissed,
  SYSTEM_MESSAGES_POLL_MS, type SystemMessage,
} from '@open-vfr/shared/systemMessages'
import { STATUS_URL } from '../config'
import { ACTIVE_ENVIRONMENT } from '../environment'
import { theme } from '../styles/theme'

// Per environment: production and staging notices must not mix.
const CACHE_KEY = `ovfr:systemMessages:doc:${ACTIVE_ENVIRONMENT}`
const DISMISSED_KEY = 'ovfr:systemMessages:dismissed'

const ACCENT: Record<SystemMessage['severity'], string> = {
  info: '#38bdf8',
  warning: '#f59e0b',
  critical: '#ef4444',
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function useSystemMessages() {
  const [messages, setMessages] = useState<SystemMessage[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!STATUS_URL) return
    let cancelled = false
    void (async () => {
      const [doc, dis] = await Promise.all([readJson<unknown>(CACHE_KEY, null), readJson<string[]>(DISMISSED_KEY, [])])
      if (cancelled) return
      setDismissed(Array.isArray(dis) ? dis.filter(x => typeof x === 'string') : [])
      setMessages(prev => (prev.length ? prev : parseSystemMessages(doc)))
    })()
    const load = async () => {
      setNow(Date.now())
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      try {
        const res = await fetch(STATUS_URL, { signal: ctrl.signal, headers: { 'Cache-Control': 'no-cache' } })
        if (!res.ok) return
        const doc: unknown = await res.json()
        if (cancelled) return
        setMessages(parseSystemMessages(doc))
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(doc)).catch(() => {})
      } catch {
        /* offline / host down: keep the last good copy */
      } finally {
        clearTimeout(timer)
      }
    }
    void load()
    const id = setInterval(() => { void load() }, SYSTEM_MESSAGES_POLL_MS)
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') void load() })
    return () => { cancelled = true; clearInterval(id); sub.remove() }
  }, [])

  useEffect(() => {
    if (messages.length === 0) return
    const pruned = pruneDismissed(dismissed, messages)
    if (pruned.length !== dismissed.length) {
      setDismissed(pruned)
      void AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(pruned)).catch(() => {})
    }
  }, [messages, dismissed])

  const active = useMemo(() => activeSystemMessages(messages, {
    now,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    appVersion: Application.nativeApplicationVersion,
    dismissed,
  }), [messages, now, dismissed])

  const dismiss = useCallback((id: string) => {
    setDismissed(prev => {
      const next = prev.includes(id) ? prev : [...prev, id]
      void AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(next)).catch(() => {})
      return next
    })
  }, [])

  return { active, dismiss }
}

function Notice({ m, onDismiss }: { m: SystemMessage; onDismiss: () => void }) {
  const [open, setOpen] = useState(m.severity === 'critical')
  const hasDetails = !!m.body || !!m.url
  return (
    <View
      testID={`system-message-${m.id}`}
      accessibilityRole={m.severity === 'critical' ? 'alert' : 'summary'}
      style={{
        backgroundColor: theme.surfaceSheet, borderColor: theme.borderDefault, borderWidth: 1,
        borderLeftWidth: 4, borderLeftColor: ACCENT[m.severity], borderRadius: 10,
        paddingVertical: 8, paddingLeft: 12, paddingRight: 8,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <TouchableOpacity style={{ flex: 1 }} disabled={!hasDetails} onPress={() => setOpen(o => !o)} accessibilityRole="button">
          <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '600' }}>{m.title}</Text>
          {hasDetails && !open && <Text style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>Tap for details</Text>}
        </TouchableOpacity>
        {isDismissible(m) && (
          <TouchableOpacity onPress={onDismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Dismiss: ${m.title}`}>
            <Text style={{ color: theme.textMuted, fontSize: 15 }}>{'\u2715'}</Text>
          </TouchableOpacity>
        )}
      </View>
      {open && !!m.body && <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 6, lineHeight: 17 }}>{m.body}</Text>}
      {open && !!m.url && (
        <Text style={{ color: ACCENT.info, fontSize: 12, marginTop: 6 }} onPress={() => { void Linking.openURL(m.url!) }}>
          More information
        </Text>
      )}
    </View>
  )
}

/** Most severe notice first; "+N more" expands the rest. Leaves the right-hand map control column free. */
export function SystemMessages() {
  const insets = useSafeAreaInsets()
  const { active, dismiss } = useSystemMessages()
  const [showAll, setShowAll] = useState(false)
  if (active.length === 0) return null
  const shown = showAll ? active : active.slice(0, 1)
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute', top: insets.top + (ACTIVE_ENVIRONMENT === 'staging' ? 22 : 6),
        left: insets.left + 10, right: insets.right + 64, zIndex: 990, elevation: 990, gap: 6,
      }}
    >
      {shown.map(m => <Notice key={m.id} m={m} onDismiss={() => dismiss(m.id)} />)}
      {active.length > 1 && (
        <TouchableOpacity
          onPress={() => setShowAll(s => !s)}
          style={{ alignSelf: 'center', backgroundColor: theme.surfaceSheet, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 }}
        >
          <Text style={{ color: theme.textSecondary, fontSize: 11 }}>
            {showAll ? 'Show fewer' : `+${active.length - 1} more notice${active.length > 2 ? 's' : ''}`}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  )
}
