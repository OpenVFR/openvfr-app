/**
 * Printable NOTAM briefing -- opens a clean, self-contained document in a new
 * window and invokes the browser's print dialog (which also offers
 * "Save as PDF"). Gives the pilot a dated record of what was reviewed
 * pre-flight, independent of the live app state.
 *
 * NOTAM text is untrusted upstream data: the document is built exclusively
 * with createElement/textContent, never innerHTML, so nothing in a NOTAM
 * body can inject markup or script into the print window.
 */
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { fmtNotamDate } from '@open-vfr/shared/fetchNotam'
import { notamTitle } from '@open-vfr/shared/notamQCode'
import { notamValidity } from '@open-vfr/shared/notamValidity'
import { notamText, type NotamTextView } from '@open-vfr/shared/notamIcaoFormat'

export interface BriefingSection {
  heading: string
  /** Optional one-line note under the heading (e.g. route-filter scope). */
  note?: string
  notams: NotamItem[]
}

export interface BriefingDoc {
  /** e.g. "ESSB — Stockholm/Bromma". */
  title: string
  sections: BriefingSection[]
  /** Text view to print each NOTAM in (default 'full'). */
  textView?: NotamTextView
  /** Printed under the header, e.g. what relevance filters hid. */
  note?: string
}

const PRINT_CSS = `
  body { font: 12px/1.4 system-ui, sans-serif; color: #000; margin: 16mm; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #444; margin-bottom: 12px; }
  h2 { font-size: 14px; border-bottom: 1px solid #000; margin: 18px 0 6px; padding-bottom: 2px; }
  .note { font-style: italic; color: #444; margin: 0 0 6px; }
  .n { break-inside: avoid; border-bottom: 1px solid #ccc; padding: 6px 0; }
  .t { font-weight: 700; }
  .v { font-family: monospace; color: #333; }
  .s { font-size: 10px; font-weight: 700; border: 1px solid #000; border-radius: 3px; padding: 0 4px; margin-left: 6px; }
  pre { white-space: pre-wrap; font: 11px/1.35 monospace; margin: 4px 0 0; }
  .empty { color: #666; }
  .disc { margin-top: 18px; font-size: 10px; color: #444; }
  @page { margin: 12mm; }
`

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, text?: string, cls?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag)
  if (text !== undefined) e.textContent = text
  if (cls) e.className = cls
  return e
}

/** Filename-ish document title: browsers use it as the default PDF name. */
function docTitle(title: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  return `NOTAM briefing ${title} ${stamp}Z`.replace(/[\\/:*?"<>|]+/g, '-')
}

/** Returns false when the print window was blocked. */
export function printBriefingDoc(b: BriefingDoc, now: Date = new Date()): boolean {
  const w = window.open('', '_blank')
  if (!w) return false
  const d = w.document
  d.title = docTitle(b.title, now)
  const style = d.createElement('style')
  style.textContent = PRINT_CSS
  d.head.appendChild(style)

  const body = d.body
  body.appendChild(el(d, 'h1', `NOTAM briefing — ${b.title}`))
  const nowMs = now.getTime()
  // The same published notice can reach us several times under different
  // upstream records (one per filing location, each with its own nmsId but
  // identical number + text) -- print it once. Dedup is display-only and
  // requires BOTH number and text to match, so two unrelated NOTAMs that
  // merely share a reused number are still both printed.
  const seen = new Set<string>()
  const sections = b.sections.map(sec => ({
    ...sec,
    notams: sec.notams.filter(n => {
      const key = `${n.id}|${n.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  }))
  const total = sections.reduce((acc, x) => acc + x.notams.length, 0)
  body.appendChild(el(d, 'div',
    `Generated ${now.toISOString().slice(0, 16).replace('T', ' ')}Z · ${total} NOTAM${total === 1 ? '' : 's'}`,
    'meta'))
  if (b.note) body.appendChild(el(d, 'p', b.note, 'note'))
  if ((b.textView ?? 'full') === 'raw') {
    body.appendChild(el(d, 'p', 'Raw view: ICAO item layout reconstructed from the published NOTAM fields, not the verbatim original message.', 'note'))
  }
  for (const sec of sections) {
    body.appendChild(el(d, 'h2', `${sec.heading} (${sec.notams.length})`))
    if (sec.note) body.appendChild(el(d, 'p', sec.note, 'note'))
    if (sec.notams.length === 0) { body.appendChild(el(d, 'div', 'None.', 'empty')); continue }
    for (const n of sec.notams) {
      const row = el(d, 'div', undefined, 'n')
      const head = el(d, 'div')
      head.appendChild(el(d, 'span', notamTitle(n), 't'))
      const v = notamValidity(n.effective, n.expires, nowMs)
      if (v.state !== 'unknown') head.appendChild(el(d, 'span', v.label, 's'))
      row.appendChild(head)
      const view = b.textView ?? 'full'
      // The Full view already starts with its own validity line.
      if (view !== 'full') {
        const eff = fmtNotamDate(n.effective)
        const exp = fmtNotamDate(n.expires)
        if (eff || exp) row.appendChild(el(d, 'div', `${eff ?? '—'} – ${exp ?? 'PERM/EST'}`, 'v'))
      }
      row.appendChild(el(d, 'pre', notamText(n, view)))
      body.appendChild(row)
    }
  }
  body.appendChild(el(d, 'div',
    'Supplementary briefing aid only. Verify against official AIS/NOTAM sources before flight.',
    'disc'))

  // Let layout settle before opening the dialog (some browsers print blank otherwise).
  w.setTimeout(() => { w.focus(); w.print() }, 100)
  return true
}
