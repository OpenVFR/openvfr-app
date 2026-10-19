/** Next free default place name: "Place 1", "Place 2", etc. (case-insensitive). */
export function nextPlaceName(existing: string[]): string {
  const taken = new Set(existing.map(n => n.trim().toLowerCase()))
  let n = 1
  while (taken.has(`place ${n}`)) n++
  return `Place ${n}`
}
