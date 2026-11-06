/**
 * notamFrequency.ts -- VHF frequencies named in free text ("CONTACT 118.105",
 * "FREQ 118,105"). Only values inside the aeronautical VHF band 108-137 MHz
 * count, so a wind ("250.5 KT"), a phone or fax number ("070.123") or a
 * runway heading is never taken for a frequency.
 */
export interface FoundFrequency { mhz: number; start: number; end: number }

const FREQ = /(?<![\d.,])(\d{3})[.,](\d{1,3})(?![\d])/g

export function findFrequencies(text: string): FoundFrequency[] {
  const out: FoundFrequency[] = []
  for (const m of text.matchAll(FREQ)) {
    const mhz = Number(`${m[1]}.${m[2]}`)
    if (mhz < 108 || mhz > 137) continue
    // "250.5 KT"-style neighbours are excluded by the band; a unit that says it is not MHz is too.
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 4).trim().toUpperCase()
    if (/^(?:KT|KTS|FT|M\b|KM|NM|DEG|°)/.test(after)) continue
    out.push({ mhz, start: m.index!, end: m.index! + m[0].length })
  }
  return out
}
