/**
 * Fold a name for searching: "Västerås", "VÄSTERÅS" and "Vasteras" are the same search key; so are "København" and "Kobenhavn", "Düsseldorf"
 * and "Dusseldorf", "Straße" and "STRASSE". The key is upper case, without accents, with the letters that do not decompose (ø æ œ ß đ ł)
 * written the usual ASCII way.
 *
 * Search boxes fold the query once and each name through here. A name is folded at most once per session (a bounded cache), and plain ASCII
 * skips the Unicode work: typing in a list of a few thousand places must not normalise every name on every keystroke.
 */

const SPECIAL: Record<string, string> = { 'Ø': 'O', 'Æ': 'AE', 'Œ': 'OE', 'ß': 'SS', 'ẞ': 'SS', 'Đ': 'D', 'Ł': 'L', 'İ': 'I', 'ı': 'I' }
const SPECIAL_RX = /[ØÆŒßẞĐŁİı]/g
const NON_ASCII = /[^\x00-\x7f]/
const MARKS = /[\u0300-\u036f]/g
const CACHE_MAX = 20000
const cache = new Map<string, string>()

/** The search key of a name or a query (upper case, accents folded). */
export function foldForSearch(s: string): string {
  if (!NON_ASCII.test(s)) return s.toUpperCase()
  const hit = cache.get(s)
  if (hit !== undefined) return hit
  const up = s.toUpperCase().replace(SPECIAL_RX, c => SPECIAL[c] ?? c)
  const out = up.normalize('NFD').replace(MARKS, '').replace(SPECIAL_RX, c => SPECIAL[c] ?? c)
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(s, out)
  return out
}
