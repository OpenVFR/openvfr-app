import { createContext } from 'react'

/**
 * Closes the working route the safe way: RouteLibrary provides its
 * "New Route" path, which asks Save / Discard / Cancel when the route has
 * unsaved changes. RoutePlan's "Close route" uses it so both actions, which
 * do the same thing, are equally safe. Null outside a RouteLibrary.
 */
export const RouteCloseContext = createContext<(() => void) | null>(null)
