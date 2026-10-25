/**
 * useAlertLog — keeps the last half hour of alerts the stack showed (see
 * @open-vfr/shared/alertLog) and returns those no longer on screen, newest
 * first, so a dismissed or timed-out alert can be looked up again.
 *
 * The list lives in a ref. The effect runs only when the SET of shown keys
 * changes (never on every render), and then bumps a counter once so the
 * "recent" list re-renders. Item text changes (distances) do not matter.
 */
import { useEffect, useRef, useState } from 'react'
import { recordAlerts, markDeparted, pastAlerts, type AlertLogEntry, type LoggableAlert } from '@open-vfr/shared/alertLog'

export function useAlertLog(shown: readonly LoggableAlert[]): AlertLogEntry[] {
  const logRef = useRef<AlertLogEntry[]>([])
  const prevKeysRef = useRef<Set<string>>(new Set())
  const shownRef = useRef(shown)
  shownRef.current = shown
  const [, setVersion] = useState(0)
  const keySig = shown.map(s => s.key).join('|')

  useEffect(() => {
    const now = Date.now()
    const items = shownRef.current
    const keys = new Set(items.map(s => s.key))
    const departed = markDeparted(logRef.current, prevKeysRef.current, keys, now)
    logRef.current = recordAlerts(departed, items, prevKeysRef.current, now).log
    prevKeysRef.current = keys
    setVersion(v => v + 1)
  }, [keySig])

  return pastAlerts(logRef.current, new Set(shown.map(s => s.key)))
}
