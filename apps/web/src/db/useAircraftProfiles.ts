import { useState, useEffect, useCallback } from 'react'
import { getDb, type AircraftProfileDocType } from './index'

// ---------------------------------------------------------------------------
// Public hook — reactive list of all saved aircraft profiles + CRUD ops.
// ---------------------------------------------------------------------------

export interface AircraftProfilesHook {
  profiles:       AircraftProfileDocType[]
  saveProfile:    (doc: Omit<AircraftProfileDocType, 'id' | 'updatedAt'> & { id?: string }) => Promise<string>
  deleteProfile:  (id: string) => Promise<void>
  duplicateProfile: (id: string) => Promise<void>
}

export function useAircraftProfiles(): AircraftProfilesHook {
  const [profiles, setProfiles] = useState<AircraftProfileDocType[]>([])

  useEffect(() => {
    let unsub: (() => void) | null = null
    getDb().then(db => {
      const sub = db.aircraft_profiles.find().$.subscribe(docs => {
        setProfiles([...docs].sort((a, b) => a.name.localeCompare(b.name)).map(d => d.toJSON()))
      })
      unsub = () => sub.unsubscribe()
    }).catch(console.error)
    return () => unsub?.()
  }, [])

  const saveProfile = useCallback(async (
    data: Omit<AircraftProfileDocType, 'id' | 'updatedAt'> & { id?: string },
  ): Promise<string> => {
    const db  = await getDb()
    // Must be a real UUID — user_aircraft_profiles.id is a Postgres UUID column;
    // any other string format 400s on every cloud push ("invalid input syntax
    // for type uuid"), silently keeping the profile local-only forever.
    const id  = data.id ?? crypto.randomUUID()
    await db.aircraft_profiles.upsert({ ...data, id, updatedAt: Date.now() })
    return id
  }, [])

  const deleteProfile = useCallback(async (id: string): Promise<void> => {
    const db  = await getDb()
    const doc = await db.aircraft_profiles.findOne(id).exec()
    await doc?.remove()
  }, [])

  const duplicateProfile = useCallback(async (id: string): Promise<void> => {
    const db  = await getDb()
    const doc = await db.aircraft_profiles.findOne(id).exec()
    if (!doc) return
    const src = doc.toJSON()
    const newId = crypto.randomUUID()
    await db.aircraft_profiles.upsert({
      ...src,
      id: newId,
      name: `${src.name} (copy)`,
      updatedAt: Date.now(),
    })
  }, [])

  return { profiles, saveProfile, deleteProfile, duplicateProfile }
}
