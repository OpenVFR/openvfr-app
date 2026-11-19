/**
 * Relevant aerodrome: the one whose sheet was opened last. The reporting points of club maps and charts (aerodrome details) are drawn only
 * for it -- same behaviour as web's utils/aerodromeDetails.ts. Stays after the sheet closes, until another aerodrome is opened or the app is closed.
 */
import { createValueStore, useStoreValue } from './valueStore'

const NONE: readonly string[] = []
const store = createValueStore<readonly string[]>(NONE)

export function setRelevantAerodrome(id: string | null): void {
  const cur = store.get()
  if ((cur[0] ?? null) === id) return
  store.set(id ? [id] : NONE)
}

export const useRelevantAerodromes = (): readonly string[] => useStoreValue(store)
