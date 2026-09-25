/**
 * notamDesignator — shared designator-code extraction for NOTAM free text.
 *
 * NMS-API NOTAM text references restricted/danger/temporary-reserved areas
 * by designator (e.g. "DANGER AREA ESD873 OPTAND COMPLETELY WITHDRAWN",
 * "TEMPORARY RESTRICTED AREA ESR374 KRAKERED..."). Swedish OFMX naming
 * convention: 2-letter country prefix + R(estricted)/D(anger) + 1-4 digit
 * number.
 *
 * Used by:
 *  - useNotamAirspaceMatch.ts (web) — matches a designator against a
 *    charted se-airspace.geojson polygon's own `name` property.
 *  - AirspacePopup.tsx (web) — groups ad-hoc regional-NOTAM circles/points
 *    that reference the SAME designator but have no charted polygon yet
 *    (e.g. recurring daily-activation notices for one temporary area,
 *    each published as its own NOTAM number) into a single popup card,
 *    instead of one card per NOTAM number.
 */

const DESIGNATOR_RE = /\b([A-Z]{2}[RD]\d{1,4})\b/g

export function extractDesignators(text: string): string[] {
  return [...new Set(text.match(DESIGNATOR_RE) ?? [])]
}
