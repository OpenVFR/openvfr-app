/**
 * Circuit focus: the runway end tapped in the aerodrome sheet (experimental aerodrome details). While set, the map
 * draws only that runway end's circuits at that aerodrome -- same behaviour as web's utils/aerodromeDetails.ts.
 */
import type { CircuitFocus } from '@open-vfr/shared/aerodromeDetailsStyle'
import { createValueStore, useStoreValue } from './valueStore'

const store = createValueStore<CircuitFocus | null>(null)

export function setCircuitFocus(f: CircuitFocus | null): void {
  const cur = store.get()
  if (f?.aerodrome === cur?.aerodrome && f?.runway === cur?.runway) return
  store.set(f)
}

export const useCircuitFocus = (): CircuitFocus | null => useStoreValue(store)
