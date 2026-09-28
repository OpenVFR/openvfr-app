/**
 * atcStatus — derives a towered airport's current ATC open/closed status
 * from its published `hours_of_operation[]` (AIP/OpenAIP schedule), and
 * flags (text-only, non-authoritative) whether any currently-active NOTAM
 * text looks ATC/tower-related.
 *
 * Deliberately conservative: this NEVER colors the map or claims a
 * definitive status from NOTAM text alone — NOTAM free text is unstructured
 * and a keyword match is only ever a "go check the NOTAM tab" hint, shown
 * as plain text next to the AIP-schedule-derived badge, never overriding
 * it. `hours_of_operation` and `towered` come from the tile pipeline
 * (OFMX + OpenAIP gap-fill) -- see docs/self-hosting.md.
 */

export type AtcStatus = 'open' | 'closed' | 'unknown'

export interface HoursEntry {
  /** 'MON'..'SUN', or null meaning "every day" */
  day:      string | null
  /** 'HH:MM', UTC (same convention as sunrise/sunset display elsewhere in
   *  this app) — null when this entry uses sunrise/sunset instead. */
  start:    string | null
  end:      string | null
  sunrise:  boolean
  sunset:   boolean
  /** "By NOTAM" / PPR-style entries that don't define a fixed schedule at
   *  all — can't be used to derive open/closed on their own. */
  by_notam: boolean
  remarks:  string
}

export interface SunTimes {
  rise: Date | null
  set:  Date | null
}

const DAY_INDEX: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
}

function parseHm(s: string | null): number | null {
  if (!s) return null
  const m = /^(\d{1,2}):?(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mi = parseInt(m[2], 10)
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

function minutesUtc(d: Date | null): number | null {
  return d ? d.getUTCHours() * 60 + d.getUTCMinutes() : null
}

export interface AtcStatusResult {
  status: AtcStatus
  /** The schedule entry that put it "open", if status === 'open'. */
  activeEntry: HoursEntry | null
}

/**
 * Compute AIP-schedule-derived ATC status. Returns 'unknown' whenever there
 * isn't enough usable data to say either way (no hours at all, or every
 * entry is a "by NOTAM" placeholder) — deliberately does not guess.
 */
export function computeAtcStatus(
  hours: HoursEntry[] | null | undefined,
  sunTimes: SunTimes,
  now: Date = new Date(),
): AtcStatusResult {
  if (!hours || hours.length === 0) return { status: 'unknown', activeEntry: null }

  const nowMin  = now.getUTCHours() * 60 + now.getUTCMinutes()
  const nowDow  = now.getUTCDay()
  const riseMin = minutesUtc(sunTimes.rise)
  const setMin  = minutesUtc(sunTimes.set)

  let anyFixedEntry = false

  for (const h of hours) {
    if (h.by_notam) continue
    if (h.day && DAY_INDEX[h.day] !== nowDow) continue

    const startMin = h.sunrise ? riseMin : parseHm(h.start)
    const endMin   = h.sunset  ? setMin  : parseHm(h.end)
    if (startMin == null || endMin == null) continue

    anyFixedEntry = true

    const within = startMin <= endMin
      ? (nowMin >= startMin && nowMin <= endMin)
      // overnight wrap, e.g. 22:00–06:00
      : (nowMin >= startMin || nowMin <= endMin)

    if (within) return { status: 'open', activeEntry: h }
  }

  if (!anyFixedEntry) return { status: 'unknown', activeEntry: null }
  return { status: 'closed', activeEntry: null }
}

// ---------------------------------------------------------------------------
// Keyword vocabulary -- tuned against REAL ICAO/FAA NOTAM phraseology, not
// guessed. Sources: FAA Order JO 7340.2 contractions + NOTAM chap 5 "Services
// NOTAMs" examples (SVC TWR CLSD / SVC TWR OPN PLUS / SVC ATIS NOT AVBL /
// SVC TWR COMMISSIONED), ICAO Doc 8400 abbreviations (H24/HJ/HN/HX/HO/HS
// schedule codes; AVBL, U/S, WIE, TEMPO contractions; Q-code AH = "hours of
// service are now (specify)"), and real live European (EAD/Eurocontrol)
// item-E) examples: "INVERNESS ATZ OPR HR CHANGED", "TARTU AFIS HR OF
// SERVICE: ...", "ALEXANDOUPOLIS AD OPR HR AS FLW: FROM ... TILL ...".
// Key finding from those real examples: NOTAMs that publish new hours often
// do NOT contain any change-verb at all ("AFIS HR OF SERVICE: MON-FRI
// 0230-0330..." just states the hours directly) -- a change-verb-only
// heuristic would miss most of them. See isNotamHoursChangeRelated below.
// ---------------------------------------------------------------------------

// Facility term: TWR/ATC/TOWER/AFIS/APP as before, plus ATZ (Aerodrome
// Traffic Zone -- real example above uses "ATZ OPR HR" for tower hours).
const ATC_TERM = /\b(TWR|ATC|TOWER|AFIS|APP|ATZ)\b/i

// Closure/outage/status vocabulary, expanded from FAA's actual SVC-NOTAM
// examples and ICAO Doc 8400 status contractions: CLSD ("SVC TWR CLSD"),
// U/S + its ICAO Doc 8400 spellout UNSERVICEABLE, SUSPENDED, WITHDRAWN (Doc
// 8400 "AC" = withdrawn for maintenance), DECOMMISSIONED, OUT OF SERVICE,
// OUTAGE, UNAVBL/UNAVAILABLE/NOT AVBL ("SVC ATIS NOT AVBL").
const CLOSED_TERM = /\b(CLSD|CLOSED|SUSPENDED|WITHDRAWN|DECOMMISSIONED|U\/S|UNSERVICEABLE|OUT\s+OF\s+SERVICE|OUTAGE|UNAVBL|UNAVAILABLE|NOT\s+AVBL)\b/i

/** True if this NOTAM's free text mentions both an ATC/tower facility term
 *  and a closure/outage term — a hint only, shown as text, not a status override. */
export function isNotamAtcRelated(text: string): boolean {
  if (!text) return false
  return ATC_TERM.test(text) && CLOSED_TERM.test(text)
}

/** Given a list of NOTAM texts, true if any looks ATC/tower related per
 *  isNotamAtcRelated(). Caller is responsible for only passing NOTAMs whose
 *  effective/expires window covers "now" (active NOTAMs). */
export function anyNotamAtcRelated(notamTexts: (string | null | undefined)[]): boolean {
  return notamTexts.some((t) => !!t && isNotamAtcRelated(t))
}

// DISTINCT signal from isNotamAtcRelated()/CLOSED_TERM above: a hint that
// hours may have changed is different from a hint that the facility may be
// closed right now, and both can legitimately fire on different active
// NOTAMs for the same airport at once. Same rule applies: text-only hint,
// never parses out or trusts a new schedule from free text, never overrides
// the AIP-schedule-derived status/color.
//
// Tier 1 -- direct "OPR HR"/"HR OF SERVICE"/"OPERATING HOURS" phrase, no
// change-verb required. This is the PRIMARY real-world pattern: all three
// live European examples above state new hours directly in this phrasing
// without ever using a word like "changed"/"amended" (a NOTAM being active
// at all already implies a temporary departure from the charted AIP
// schedule -- the phrase itself is the signal). Deliberately not restricted
// to a facility-name prefix (AD/TWR/ATZ/AFIS) -- "ALEXANDOUPOLIS AD OPR HR
// AS FLW" and "TARTU AFIS HR OF SERVICE" both put the airport/facility name
// as a free-standing prefix that a strict word-boundary facility check
// would need to separately special-case for no real benefit; the phrase
// itself is specific enough on its own to be low-false-positive.
const HOURS_PHRASE_TERM = /\bOPR\s*HRS?\b|\bHRS?\s+OF\s+SERVICE\b|\bOPERATING\s+HOURS?\b/i

// Tier 2 -- fallback for phrasings that use "HR"/"HOURS" + a facility term
// together with an explicit change-style word, for cases Tier 1's specific
// phrase doesn't cover (e.g. "TWR HR CHANGED TO 0600-2000", "NEW TWR HR
// WEF 01 JAN"). Includes AS FLW ("as follows", real Greek example) and WEF
// ("with effect from", ICAO Doc 8400 contraction) as change-style terms in
// addition to plain-English change verbs, and COMMISSIONED (Doc 8400 "AK" =
// resumed normal operation / FAA "SVC TWR COMMISSIONED") for a
// closed-then-reopened schedule change.
const HOURS_FACILITY_TERM = /\b(TWR|ATC|TOWER|AFIS|APP|AD|ATZ|AERODROME|AIRPORT)\b/i
const HOURS_TERM  = /\b(HR|HRS|HOURS?)\b/i
const CHANGE_TERM = /\b(CHANGE[SD]?|CHANGING|AMEND(ED|S)?|REVIS(ED?|E)|REV|EXTEND(ED|S)?|REDUC(ED|E|ES)?|MODIF(Y|IED|IES)|ALTER(ED|S)?|NEW|COMMISSIONED|WEF|AS\s+FLW)\b/i

/** True if this NOTAM's free text looks like an hours-of-operation change --
 *  either the direct "OPR HR"/"HR OF SERVICE"/"OPERATING HOURS" phrase
 *  (Tier 1, the dominant real-world pattern), or a facility + "hours" +
 *  change-verb combination (Tier 2, fallback for other phrasings). Text-only
 *  hint; never used to compute or override actual status. */
export function isNotamHoursChangeRelated(text: string): boolean {
  if (!text) return false
  if (HOURS_PHRASE_TERM.test(text)) return true
  return HOURS_FACILITY_TERM.test(text) && HOURS_TERM.test(text) && CHANGE_TERM.test(text)
}

/** Given a list of (active) NOTAM texts, true if any looks like an
 *  hours-of-operation change per isNotamHoursChangeRelated(). */
export function anyNotamHoursChangeRelated(notamTexts: (string | null | undefined)[]): boolean {
  return notamTexts.some((t) => !!t && isNotamHoursChangeRelated(t))
}
