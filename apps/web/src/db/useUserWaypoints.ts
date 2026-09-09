import { useState, useEffect, useCallback } from 'react'
import { getDb, type UserWaypointDocType } from './index'

/**
 * Reactive CRUD hook for the user_waypoints RxDB collection.
 * `waypoints` is kept in sync with the database via a live subscription.
 */
export function useUserWaypoints() {
  const [waypoints, setWaypoints] = useState<UserWaypointDocType[]>([])

  useEffect(() => {
    let sub: { unsubscribe(): void } | null = null
    getDb()
      .then((db) => {
        sub = db.user_waypoints
          .find()
          .sort({ updatedAt: 'asc' })
          .$.subscribe((docs) => setWaypoints(docs.map((d) => d.toJSON())))
      })
      .catch(console.error)
    return () => { sub?.unsubscribe() }
  }, [])

  /** Create or update a user waypoint. Returns the persisted id. */
  const saveWaypoint = useCallback(
    async (wp: Omit<UserWaypointDocType, 'id' | 'updatedAt'> & { id?: string }): Promise<string> => {
      const db = await getDb()
      const id = wp.id ?? crypto.randomUUID()
      await db.user_waypoints.upsert({ ...wp, id, updatedAt: Date.now() })
      return id
    },
    [],
  )

  /** Permanently remove a waypoint by id. */
  const deleteWaypoint = useCallback(async (id: string) => {
    const db = await getDb()
    const doc = await db.user_waypoints.findOne(id).exec()
    if (doc) await doc.remove()
  }, [])

  /** Rename a waypoint in-place without changing its folder or position. */
  const renameWaypoint = useCallback(async (id: string, name: string) => {
    const db = await getDb()
    const doc = await db.user_waypoints.findOne(id).exec()
    if (doc) await doc.patch({ name, updatedAt: Date.now() })
  }, [])

  /** Move a waypoint to a different folder. Empty string = "Unfiled". */
  const moveToFolder = useCallback(async (id: string, folder: string) => {
    const db = await getDb()
    const doc = await db.user_waypoints.findOne(id).exec()
    if (doc) await doc.patch({ folder, updatedAt: Date.now() })
  }, [])

  return { waypoints, saveWaypoint, deleteWaypoint, renameWaypoint, moveToFolder }
}
