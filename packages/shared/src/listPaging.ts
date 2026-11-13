/** Rows a long list (flight logs, saved routes) draws at first, and adds per "Show more". */
export const LIST_PAGE_SIZE = 25

/** Label of the "Show more" button: how many the next page adds and how many stay hidden. */
export function showMoreLabel(total: number, shown: number, pageSize: number = LIST_PAGE_SIZE): string {
  const left = Math.max(0, total - shown)
  return `Show ${Math.min(pageSize, left)} more (${left} left)`
}
