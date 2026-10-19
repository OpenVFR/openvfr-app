/** Helpers for saved places (user waypoints). */

/** Next free default name: "Place 1", "Place 2", … (case-insensitive). */
export function nextPlaceName(existing: string[]): string {
  const taken = new Set(existing.map(n => n.trim().toLowerCase()))
  let n = 1
  while (taken.has(`place ${n}`)) n++
  return `Place ${n}`
}

/** Group places by folder (unfiled first, then folders A-Z); newest first within. */
export function groupPlaces<T extends { folder: string; updatedAt: number }>(places: T[]): { folder: string; items: T[] }[] {
  const map = new Map<string, T[]>()
  for (const p of places) {
    const k = (p.folder ?? '').trim()
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(p)
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([folder, items]) => ({ folder, items: items.sort((x, y) => y.updatedAt - x.updatedAt) }))
}
