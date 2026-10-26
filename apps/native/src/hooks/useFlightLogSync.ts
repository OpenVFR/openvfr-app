/**
 * useFlightLogSync — flight logs (local AsyncStorage) with cloud sync.
 *
 * The sync itself runs in ../sync/cloudSync.ts. Completed logs (endedAt > 0)
 * are uploaded; logs from other devices are downloaded; deletes propagate.
 * The in-progress log never leaves the device.
 *
 * A flight usually ends without connectivity, so an upload that fails is
 * kept and retried (with backoff, on every return to the foreground, and on
 * the periodic sync) until the server has it. A log is never removed locally
 * unless the server holds a delete for it that is newer than the log.
 */

import { useState, useEffect, useCallback } from 'react'
import { flightLogs as flightLogsDb } from '../db'
import type { FlightLogDocType } from '../types/db'
import { notifyLocalChange, notifyLocalDelete, syncNow, useTableSync } from '../sync/cloudSync'
import { isSyncableLog } from '@open-vfr/shared/cloudSyncRows'
export function useFlightLogSync() {
  const { status, localVersion } = useTableSync('user_flight_logs')
  const [logs, setLogs] = useState<FlightLogDocType[]>([])

  const refresh = useCallback(async () => {
    setLogs(await flightLogsDb.getAll())
  }, [])

  useEffect(() => { void refresh() }, [refresh, localVersion])

  /** Run a sync round now (pull-to-refresh on the Logs segment). */
  const pull = useCallback(async () => {
    await syncNow('user_flight_logs')
    await refresh()
  }, [refresh])

  /** A log finished (or was imported): upload it soon (simulated logs never are). */
  const pushLog = useCallback(async (doc: FlightLogDocType) => {
    await refresh()
    if (isSyncableLog(doc)) notifyLocalChange('user_flight_logs')
  }, [refresh])

  /** Delete locally now; the server delete is queued until it succeeds.
   *  A simulated log was never uploaded, so it has no server copy to delete. */
  const deleteLog = useCallback(async (id: string) => {
    const simulated = (await flightLogsDb.getAll()).find(l => l.id === id)?.simulated === true
    await flightLogsDb.delete(id)
    await refresh()
    if (!simulated) await notifyLocalDelete('user_flight_logs', id)
  }, [refresh])

  /** Remove every completed simulated log from this device. Returns how many. */
  const deleteSimulatedLogs = useCallback(async (): Promise<number> => {
    const sims = (await flightLogsDb.getAll()).filter(l => l.simulated === true && l.endedAt > 0)
    for (const l of sims) await flightLogsDb.delete(l.id)
    await refresh()
    return sims.length
  }, [refresh])

  return { syncState: status, logs, refresh, pull, pushLog, deleteLog, deleteSimulatedLogs }
}
