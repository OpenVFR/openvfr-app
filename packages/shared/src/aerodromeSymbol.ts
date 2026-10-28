/**
 * Aerodrome chart symbol: a circle with the main runway drawn through it,
 * turned to the runway's true bearing. Shared by the web and native map
 * layers so both pick the same image for the same aerodrome.
 *
 * Uses flat properties of each aerodrome feature in the aerodromes dataset
 * (style expressions cannot search the nested runway list):
 *   rwy_brg    0..179, true bearing of the main runway (absent: no runway data)
 *   rwy_paved  main runway has a hard surface
 *   ad_use     civil | military | joint | private | ultralight | glider | closed
 * plus `type` (HP = heliport) and `towered`.
 *
 * Images (public/poi_icons/<id>.svg, native assets/poi_icons/<id>.png):
 *   ad-<kind>-<bar>  kind: civ (controlled), civ-open (uncontrolled), mil,
 *                    joint, minor (private / ultralight / glider)
 *                    bar:  hard (paved), soft (unpaved), none (no runway data)
 *   ad-closed, ad-heliport, ad-heliport-mil
 *   ad-airport       the older plain symbol, for data without these properties
 */

export const AERODROME_SYMBOL_KINDS = ['civ', 'civ-open', 'mil', 'joint', 'minor'] as const
export const AERODROME_SYMBOL_BARS = ['hard', 'soft', 'none'] as const

/** Every runway-symbol image id (generated SVGs/PNGs). */
export const AERODROME_SYMBOL_IDS: string[] = [
  ...AERODROME_SYMBOL_KINDS.flatMap((k) => AERODROME_SYMBOL_BARS.map((b) => `ad-${k}-${b}`)),
  'ad-closed',
]

/** Symbol colours: the single source for the generated images
 *  (apps/web/scripts/gen-aerodrome-icons.mjs, apps/native/scripts/gen-poi-icons.mjs)
 *  and the tint of the heliport images. */
export const AERODROME_SYMBOL_COLORS = {
  civil: '#1a56db',
  military: '#b91c1c',
  heliport: '#9333ea',
  /** private / ultralight / glider / closed */
  minor: '#64748b',
}

/**
 * Style expression: the image id for an aerodrome feature.
 *
 * Every `case` condition here is a plain comparison or `has`, never `!`,
 * `all` or `any`: MapLibre iOS converts layer expressions through
 * NSExpression, and in a `case` with more than one condition it drops any
 * compound condition (the layer then throws "Invalid property value" and the
 * app aborts when the map style loads). See ./iosSafeExpression.ts.
 */
export const aerodromeIconImage: unknown[] = [
  'case',
  ['==', ['get', 'type'], 'HP'],
  ['case', ['==', ['get', 'ad_use'], 'military'], 'ad-heliport-mil', 'ad-heliport'],
  ['==', ['get', 'ad_use'], 'closed'], 'ad-closed',
  ['has', 'ad_use'],
  [
    'concat', 'ad-',
    [
      'match', ['get', 'ad_use'],
      'military', 'mil',
      'joint', 'joint',
      ['private', 'ultralight', 'glider'], 'minor',
      ['case', ['==', ['get', 'towered'], true], 'civ', 'civ-open'],
    ],
    '-',
    ['case', ['has', 'rwy_brg'], ['case', ['==', ['get', 'rwy_paved'], true], 'hard', 'soft'], 'none'],
  ],
  // Data built before the symbol properties existed: keep the plain symbol.
  'ad-airport',
]

/** Style expression: icon rotation (clockwise degrees), with
 *  `icon-rotation-alignment: 'map'` so it keeps the true runway direction
 *  when the map is turned (track up). */
export const aerodromeIconRotate: unknown[] = ['coalesce', ['get', 'rwy_brg'], 0]
