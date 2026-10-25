/**
 * useAlertLog — keeps the last half hour of alerts the stack showed (see
 * @open-vfr/shared/alertLog) and returns those no longer on screen, newest
 * first, so a dismissed or timed-out alert can be looked up again.
 *
 * The list lives in a ref and only a counter is state: item text (distances)
 * changes every tick, which must not re-render.
 */
import { useEffect, useRef, useState } from 'react'
import { recordAlerts, pastAlerts, type AlertLogEntry, type LoggableAlert } from '@open-vfr/shared/alertLog'

export function useAlertLog(shown: readonly LoggableAlert[]): AlertLogEntry[] {
  const logRef = useRef<AlertLogEntry[]>([])
  const prevKeysRef = useRef<Set<string>>(new Set())
  const [, setVersion] = useState(0)

  useEffect(() => {
    const r = recordAlerts(logRef.current, shown, prevKeysRef.current, Date.now())
    logRef.current = r.log
    const keys = new Set(shown.map(s => s.key))
    const changedKeys = keys.size !== prevKeysRef.current.size || [...keys].some(k => !prevKeysRef.current.has(k))
    prevKeysRef.current = keys
    // Re-render only when something entered or left the screen: the "recent" list depends on it.
    if (r.added || changedKeys) setVersion(v => v + 1)
  })

  return pastAlerts(logRef.current, new Set(shown.map(s => s.key)))
}
