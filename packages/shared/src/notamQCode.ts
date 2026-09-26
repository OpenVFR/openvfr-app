/**
 * ICAO NOTAM Code (Q-code) decoder -- PANS-AIM (Doc 10066) / Doc 8126
 * NOTAM Code tables. A Q-code is "Q" + 2-letter subject + 2-letter
 * condition, e.g. QMRLC = Runway (MR) + Closed (LC).
 *
 * Used to give a NOTAM a readable title ("Runway closed · A1234/26") in
 * place of the bare series number, which tells a pilot nothing about what
 * the notice is about until they open it. Unknown codes degrade to the plain
 * NOTAM id -- never guess.
 */

const SUBJECT: Record<string, string> = {
  // AGA lighting
  LA: 'Approach lighting', LB: 'Aerodrome beacon', LC: 'RWY centre line lights',
  LD: 'Landing direction indicator lights', LE: 'RWY edge lights', LF: 'Sequenced flashing lights',
  LG: 'Pilot-controlled lighting', LH: 'High intensity RWY lights', LI: 'RWY end identifier lights',
  LJ: 'RWY alignment indicator lights', LK: 'CAT II ALS components', LL: 'Low intensity RWY lights',
  LM: 'Medium intensity RWY lights', LP: 'PAPI', LR: 'Landing area lighting', LS: 'Stopway lights',
  LT: 'Threshold lights', LU: 'Helicopter approach path indicator', LV: 'VASIS', LW: 'Heliport lighting',
  LX: 'TWY centre line lights', LY: 'TWY edge lights', LZ: 'RWY touchdown zone lights',
  // AGA movement and landing area
  MA: 'Movement area', MB: 'Bearing strength', MC: 'Clearway', MD: 'Declared distances',
  MG: 'Taxiing guidance system', MH: 'RWY arresting gear', MK: 'Parking area', MM: 'Daylight markings',
  MN: 'Apron', MO: 'Stop bar', MP: 'Aircraft stands', MR: 'Runway', MS: 'Stopway', MT: 'Threshold',
  MU: 'RWY turning bay', MW: 'Strip/shoulder', MX: 'Taxiway', MY: 'Rapid exit TWY',
  // AGA facilities and services
  FA: 'Aerodrome', FB: 'Friction measuring device', FC: 'Ceiling measurement equipment',
  FD: 'Docking system', FE: 'Oxygen', FF: 'Rescue and fire fighting', FG: 'Ground movement control',
  FH: 'Helicopter alighting area', FI: 'De-icing', FJ: 'Oils', FL: 'Landing direction indicator',
  FM: 'Meteorological service', FO: 'Fog dispersal system', FP: 'Heliport', FS: 'Snow removal equipment',
  FT: 'Transmissometer', FU: 'Fuel availability', FW: 'Wind direction indicator', FZ: 'Customs/immigration',
  // COM and surveillance
  CA: 'Air/ground facility', CB: 'ADS-B', CC: 'ADS-C', CD: 'CPDLC', CE: 'En-route surveillance radar',
  CG: 'GCA system', CL: 'SELCAL', CM: 'Surface movement radar', CP: 'PAR', CR: 'PAR surveillance element',
  CS: 'SSR', CT: 'Terminal area surveillance radar',
  // ILS / MLS
  IC: 'ILS', ID: 'ILS DME', IG: 'Glide path', II: 'Inner marker', IL: 'Localizer', IM: 'Middle marker',
  IN: 'Localizer (non-ILS)', IO: 'Outer marker', IS: 'ILS CAT I', IT: 'ILS CAT II', IU: 'ILS CAT III',
  IW: 'MLS', IX: 'Locator, outer', IY: 'Locator, middle',
  // GNSS
  GA: 'GNSS aerodrome operations', GW: 'GNSS area-wide operations',
  // Terminal and en-route navigation facilities
  NA: 'All radio navigation facilities', NB: 'NDB', NC: 'DECCA', ND: 'DME', NF: 'Fan marker',
  NL: 'Locator', NM: 'VOR/DME', NN: 'TACAN', NO: 'OMEGA', NT: 'VORTAC', NV: 'VOR', NX: 'DF station',
  // ATM airspace organization
  AA: 'Minimum altitude', AC: 'Control zone', AD: 'ADIZ', AE: 'Control area', AF: 'FIR',
  AH: 'Upper control area', AL: 'Minimum usable FL', AN: 'RNAV route', AO: 'Oceanic control area',
  AP: 'Reporting point', AR: 'ATS route', AT: 'TMA', AU: 'UIR', AV: 'Upper advisory area',
  AX: 'Significant point', AZ: 'ATZ',
  // ATM air traffic and VOLMET services
  SA: 'ATIS', SB: 'ATS reporting office', SC: 'Area control centre', SE: 'Flight information service',
  SF: 'Aerodrome FIS', SL: 'Flow control centre', SO: 'Oceanic area control centre', SP: 'Approach control',
  SS: 'Flight service station', ST: 'Aerodrome control tower', SU: 'Upper area control centre',
  SV: 'VOLMET', SY: 'Upper advisory service',
  // ATM procedures
  PA: 'STAR', PB: 'VFR arrival', PC: 'Contingency procedures', PD: 'SID', PE: 'VFR departure',
  PF: 'Flow control procedure', PH: 'Holding procedure', PI: 'Instrument approach procedure',
  PK: 'VFR approach procedure', PL: 'Flight plan processing', PM: 'Aerodrome operating minima',
  PN: 'Noise restriction', PO: 'Obstacle clearance altitude', PR: 'Radio failure procedures',
  PT: 'Transition altitude/level', PU: 'Missed approach procedure', PX: 'Minimum holding altitude',
  PZ: 'ADIZ procedure',
  // Navigation warnings: airspace restrictions
  RA: 'Airspace reservation', RD: 'Danger area', RM: 'Military operating area', RO: 'Overflying',
  RP: 'Prohibited area', RR: 'Restricted area', RT: 'Temporary restricted area',
  // Navigation warnings: warnings
  WA: 'Air display', WB: 'Aerobatics', WC: 'Captive balloon or kite', WD: 'Explosives demolition',
  WE: 'Exercises', WF: 'Air refuelling', WG: 'Glider flying', WH: 'Blasting', WJ: 'Banner/target towing',
  WL: 'Free balloon ascent', WM: 'Missile, gun or rocket firing', WP: 'Parachuting/paragliding/hang gliding',
  WR: 'Radioactive or toxic materials', WS: 'Burning or blowing gas', WT: 'Mass movement of aircraft',
  WU: 'Unmanned aircraft', WV: 'Formation flight', WW: 'Volcanic activity', WY: 'Aerial survey',
  WZ: 'Model flying',
  // Other information
  OA: 'Aeronautical information service', OB: 'Obstacle', OE: 'Aircraft entry requirements',
  OL: 'Obstacle lights', OR: 'Rescue coordination centre',
}

const CONDITION: Record<string, string> = {
  // Availability
  AC: 'withdrawn for maintenance', AD: 'available for daylight operation', AF: 'flight checked, reliable',
  AG: 'ground checked only', AH: 'hours of service changed', AK: 'resumed normal operation',
  AL: 'operative subject to limitations', AM: 'military operations only', AN: 'available for night operation',
  AO: 'operational', AP: 'available, PPR', AR: 'available on request', AS: 'unserviceable',
  AU: 'not available', AW: 'completely withdrawn', AX: 'shutdown cancelled',
  // Changes
  CA: 'activated', CC: 'completed', CD: 'deactivated', CE: 'erected', CF: 'frequency changed',
  CG: 'downgraded', CH: 'changed', CI: 'identification/call sign changed', CL: 'realigned',
  CM: 'displaced', CN: 'cancelled', CO: 'operating', CP: 'operating on reduced power',
  CR: 'temporarily replaced', CS: 'installed', CT: 'on test, do not use',
  // Hazard conditions
  HA: 'braking action', HB: 'friction coefficient', HC: 'compacted snow', HD: 'dry snow',
  HE: 'water', HF: 'free of snow and ice', HG: 'grass cutting in progress', HH: 'hazard',
  HI: 'ice', HJ: 'launch planned', HK: 'bird migration', HL: 'snow removal completed', HM: 'marked',
  HN: 'wet snow or slush', HO: 'obscured by snow', HP: 'snow removal in progress',
  HQ: 'operation cancelled', HR: 'standing water', HS: 'sanding in progress',
  HT: 'approach by signal area only', HU: 'launch in progress', HV: 'work completed',
  HW: 'work in progress', HX: 'bird concentration', HY: 'snow banks', HZ: 'frozen ruts and ridges',
  // Limitations
  LA: 'on auxiliary power', LB: 'reserved for based aircraft', LC: 'closed', LD: 'unsafe',
  LE: 'without auxiliary power', LF: 'interference', LG: 'operating without identification',
  LH: 'unserviceable for heavier aircraft', LI: 'closed to IFR', LK: 'operating as fixed light',
  LL: 'usable length/width limited', LN: 'closed at night', LP: 'prohibited', LR: 'restricted to RWY and TWY',
  LS: 'subject to interruption', LT: 'limited', LV: 'closed to VFR', LW: 'will take place',
  LX: 'caution advised',
}

export interface DecodedQCode {
  code: string
  subject: string | null
  condition: string | null
}

/** Normalizes "QMRLC" / "MRLC" / " qmrlc " -> "QMRLC"; null if malformed. */
export function normalizeQCode(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim().toUpperCase()
  if (/^Q[A-Z]{4}$/.test(s)) return s
  // Bare 4-letter form (no leading Q). No subject starts with Q, so a
  // 4-letter string starting with Q is a truncated code, not a bare one.
  if (/^[A-PR-Z][A-Z]{3}$/.test(s)) return `Q${s}`
  return null
}

/** Pulls the Q-code out of an ICAO-format "Q) ESAA/QMRLC/IV/NBO/A/..." line. */
export function extractQCodeFromText(text: string | null | undefined): string | null {
  if (!text) return null
  const m = /Q\)\s*[A-Z]{4}\s*\/\s*(Q[A-Z]{4})\s*\//.exec(text)
  return m ? m[1] : null
}

export function decodeQCode(raw: string | null | undefined): DecodedQCode | null {
  const code = normalizeQCode(raw)
  if (!code) return null
  const subj = code.slice(1, 3)
  const cond = code.slice(3, 5)
  // Special codes: checklist, trigger, plain-language.
  if (code === 'QKKKK') return { code, subject: 'Checklist', condition: null }
  return {
    code,
    subject: SUBJECT[subj] ?? null,
    condition: cond === 'XX' || cond === 'TT' ? null : (CONDITION[cond] ?? null),
  }
}

/** Title-case only the first letter; keeps abbreviations (RWY, PAPI) intact. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Readable NOTAM title: "Runway closed · A1234/26". Falls back to subject
 * only ("Restricted area · …") when the condition is plain-language (XX) or
 * unknown, and to the bare id when the subject is unknown or no Q-code.
 */
export function notamTitle(n: { id: string; qCode?: string | null; text?: string | null }): string {
  const d = decodeQCode(n.qCode ?? extractQCodeFromText(n.text))
  if (!d?.subject) return n.id
  const head = d.condition ? `${d.subject} ${d.condition}` : d.subject
  return `${cap(head)} · ${n.id}`
}
