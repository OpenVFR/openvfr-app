import { describe, it, expect } from 'vitest'
import { extractDesignators } from './notamDesignator'

describe('extractDesignators', () => {
  it('extracts a single designator from real NOTAM free text', () => {
    expect(extractDesignators('DANGER AREA ESD873 OPTAND COMPLETELY WITHDRAWN')).toEqual(['ESD873'])
  })

  it('extracts a temporary-restricted-area designator', () => {
    expect(extractDesignators('TEMPORARY RESTRICTED AREA ESR374 KRAKERED ESTABLISHED')).toEqual(['ESR374'])
  })

  it('dedupes a designator repeated in the same text', () => {
    expect(extractDesignators('ESR448 ACTIVE. SEE ALSO ESR448 NOTE.')).toEqual(['ESR448'])
  })

  it('returns an empty array for text with no designator', () => {
    // Real example: Copenhagen (EKCH) runway-closure NOTAM text -- no
    // designator at all, only an airport ops notice. groupRegionalNotamHits()
    // in AirspacePopup.tsx relies on this returning [] so it falls through
    // to its own lat/lon/radiusNm grouping key instead.
    expect(extractDesignators('RWY 12/30 CLSD BTN RWY 04R/22L AND TWY B DUE TO WIP.')).toEqual([])
  })

  it('does not match a 1-2 digit number without R/D as the third char', () => {
    expect(extractDesignators('SEE AIP ENR 2.2 ITEM 7.')).toEqual([])
  })
})
