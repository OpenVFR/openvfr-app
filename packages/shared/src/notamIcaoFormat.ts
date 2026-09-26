/**
 * Three text views of a NOTAM, shared by web + native:
 *
 *   short -- one line: decoded subject/condition + the first sentence of E)
 *   full  -- E) text plus the schedule (D), vertical limits (F/G) and validity
 *   raw   -- the standard ICAO item layout (Q/A/B/C/D/E/F/G), REBUILT from
 *            structured fields. Not the verbatim original message: the
 *            upstream feed has no field for the NOTAM a replacement
 *            supersedes, so callers must label this view "reconstructed".
 *
 * Everything degrades to the plain free text when structured fields are
 * missing (older API deployments), never to an empty view.
 */
import type { NotamItem } from './fetchNotam'
import { notamTitle } from './notamQCode'

export type NotamTextView = 'short' | 'full' | 'raw'

type N = Pick<NotamItem, 'id' | 'text' | 'effective' | 'expires'> & Partial<Pick<NotamItem, 'qCode' | 'affectedFir' | 'icao'>>

/** ISO timestamp -> ICAO B)/C) form "YYMMDDHHMM" (UTC). */
export function icaoDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
}

/** "23 Sep 14:00Z" */
function humanUtc(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())} ${mon} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`
}

/** Far-future sentinel ends ("PERM") come through as year 9999/2099-style dates. */
const isPermanent = (iso: string | null | undefined): boolean => {
  if (!iso) return false
  const y = new Date(iso).getUTCFullYear()
  return Number.isFinite(y) && y >= 2099
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const m = /^(.{1,160}?[.!?])(\s|$)/.exec(flat)
  if (m) return m[1]
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat
}

export function notamShortText(n: N): string {
  const title = notamTitle({ id: n.id, qCode: n.qCode ?? null, text: n.text })
  const lead = firstSentence(n.text)
  // notamTitle falls back to the bare id when the Q-code is unknown -- then
  // the first sentence carries the meaning on its own.
  return title === n.id ? `${n.id} · ${lead}` : `${title} — ${lead}`
}

export function notamFullText(n: N): string {
  const f = n.icao ?? null
  const lines: string[] = []
  const from = humanUtc(n.effective)
  const to = isPermanent(n.expires) ? 'PERM' : humanUtc(n.expires)
  if (from || to) lines.push(`Valid ${from ?? '—'} – ${to ?? 'until further notice'}${f?.estimated ? ' (EST)' : ''}`)
  if (f?.schedule) lines.push(`Schedule: ${f.schedule}`)
  if (f?.lowerLimit || f?.upperLimit) lines.push(`Vertical: ${f.lowerLimit ?? '—'} – ${f.upperLimit ?? '—'}`)
  lines.push('')
  lines.push(n.text)
  return lines.join('\n').replace(/^\n+/, '')
}

/** Q-line vertical limits: "000/999" is the "no restriction" default -- omit nothing, it's part of the format. */
export function notamRawText(n: N): string {
  const f = n.icao ?? null
  if (!f) return n.text
  const radius = f.radius ? f.radius.padStart(3, '0') : ''
  const qLine = [
    n.affectedFir ?? '',
    n.qCode ?? '',
    f.traffic ?? '',
    f.purpose ?? '',
    f.scope ?? '',
    f.lowerFl ?? '',
    f.upperFl ?? '',
    `${f.coordinates ?? ''}${radius}`,
  ].join('/')
  const type = f.type ? `NOTAM${f.type}` : 'NOTAM'
  const b = icaoDateTime(n.effective)
  const c = isPermanent(n.expires) ? 'PERM' : icaoDateTime(n.expires)
  const out = [`${n.id} ${type}`, `Q) ${qLine}`]
  const abc = [
    f.location ? `A) ${f.location}` : null,
    b ? `B) ${b}` : null,
    c ? `C) ${c}${f.estimated && c !== 'PERM' ? ' EST' : ''}` : null,
  ].filter(Boolean)
  if (abc.length) out.push(abc.join(' '))
  if (f.schedule) out.push(`D) ${f.schedule}`)
  out.push(`E) ${n.text}`)
  const fg = [f.lowerLimit ? `F) ${f.lowerLimit}` : null, f.upperLimit ? `G) ${f.upperLimit}` : null].filter(Boolean)
  if (fg.length) out.push(fg.join(' '))
  return out.join('\n')
}

export function notamText(n: N, view: NotamTextView): string {
  return view === 'short' ? notamShortText(n) : view === 'raw' ? notamRawText(n) : notamFullText(n)
}

/** True when the raw view is a genuine reconstruction (has structured fields). */
export const hasRawView = (n: N): boolean => !!n.icao
