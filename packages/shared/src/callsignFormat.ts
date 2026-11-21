/**
 * How a radio callsign is written in the apps. Sources spell them differently: OFMX gives "SÖDERSLÄTT" (all capitals), openAIP and
 * the curated values "Sweden Information". One look for all: a callsign that is all capitals (or all lower case) becomes Title
 * Case; one already in mixed case is left as written. Service abbreviations that have no longer spoken form stay capitals
 * ("Malmö AFIS"; a place name that is a four-letter code is not told apart from a word, so "ESMI ATIS" becomes "Esmi ATIS").
 */
const KEEP_UPPER = new Set(['ATIS', 'AFIS', 'ATC', 'TWR', 'ACC', 'FIS', 'VOLMET', 'CTL', 'TMA', 'CTR', 'ATZ', 'TIZ', 'TIA', 'MIL'])

const cap = (w: string): string => w.split('-').map(p => (p ? p[0]!.toLocaleUpperCase('sv') + p.slice(1).toLocaleLowerCase('sv') : p)).join('-')

export function formatCallsign(cs: string | null | undefined): string {
  const t = (cs ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  if (t !== t.toLocaleUpperCase('sv') && t !== t.toLocaleLowerCase('sv')) return t
  return t.split(' ').map(w => (KEEP_UPPER.has(w.toUpperCase()) || /\d/.test(w) ? w.toUpperCase() : cap(w))).join(' ')
}
