/**
 * Scrolls `el` into view within its nearest vertically-scrollable ancestor
 * only (overflow-y: auto|scroll). Unlike Element.scrollIntoView(), this never
 * touches overflow:hidden/clip ancestors (e.g. the side drawer's own
 * translateX-animated frame), which scrollIntoView would happily shift too.
 *
 * `block: 'start'` aligns el's top with the container's top (minus `margin`);
 * `'nearest'` only scrolls when el is (partly) out of view.
 */
export function scrollIntoContainer(
  el: HTMLElement,
  { block = 'nearest', margin = 8 }: { block?: 'start' | 'nearest'; margin?: number } = {},
): void {
  let container = el.parentElement
  while (container) {
    const oy = getComputedStyle(container).overflowY
    if ((oy === 'auto' || oy === 'scroll') && container.scrollHeight > container.clientHeight) break
    container = container.parentElement
  }
  if (!container) return

  const c = container.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  let delta = 0
  if (block === 'start') {
    delta = r.top - c.top - margin
  } else if (r.top < c.top + margin) {
    delta = r.top - c.top - margin
  } else if (r.bottom > c.bottom - margin) {
    // Taller-than-viewport element: show its top rather than its bottom.
    delta = Math.min(r.bottom - c.bottom + margin, r.top - c.top - margin)
  }
  if (delta !== 0) container.scrollBy({ top: delta, behavior: 'smooth' })
}
