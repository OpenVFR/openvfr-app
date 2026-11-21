import { describe, it, expect } from 'vitest'
import { foldForSearch } from './searchFold'
import { filterAndSortAerodromes, type AerodromeEntry } from './findDestination'

describe('foldForSearch', () => {
  it('Swedish', () => {
    expect(foldForSearch('Västerås')).toBe('VASTERAS')
    expect(foldForSearch('VÄSTERÅS')).toBe('VASTERAS')
    expect(foldForSearch('vasteras')).toBe('VASTERAS')
    expect(foldForSearch('Örebro')).toBe('OREBRO')
    expect(foldForSearch('Sövde')).toBe('SOVDE')
  })
  it('Danish', () => {
    expect(foldForSearch('København')).toBe('KOBENHAVN')
    expect(foldForSearch('Ærø')).toBe('AERO')
    expect(foldForSearch('Skåne')).toBe('SKANE')
    expect(foldForSearch('Læsø')).toBe('LAESO')
  })
  it('German, French, Polish', () => {
    expect(foldForSearch('Düsseldorf')).toBe('DUSSELDORF')
    expect(foldForSearch('Straße')).toBe('STRASSE')
    expect(foldForSearch('STRASSE')).toBe('STRASSE')
    expect(foldForSearch('Genève')).toBe('GENEVE')
    expect(foldForSearch('Łódź')).toBe('LODZ')
  })
  it('is the plain upper case for ASCII, and a decomposed accent folds the same as a composed one', () => {
    expect(foldForSearch('Stockholm Arlanda ESSA')).toBe('STOCKHOLM ARLANDA ESSA')
    expect(foldForSearch('A\u0308')).toBe(foldForSearch('Ä'))
    expect(foldForSearch('')).toBe('')
    expect(foldForSearch('Västerås')).toBe(foldForSearch('Västerås'))         // the cached answer is the same
  })
})

describe('aerodrome search folds accents', () => {
  const ad = (icao: string, name: string): AerodromeEntry => ({ icao, name, lat: 59.6, lng: 16.6, elevationFt: 20, maxRunwayM: 1500, surfaces: ['ASPH'], fuel: [], type: 'AD' })
  const list = [ad('ESOW', 'Västerås Hässlö'), ad('EKCH', 'København Kastrup'), ad('EDDL', 'Düsseldorf'), ad('ESSA', 'Stockholm Arlanda')]
  const find = (search: string) => filterAndSortAerodromes(list, { lat: 59.6, lng: 16.6 }, null, { search }, null).map(a => a.icao)
  it('finds with and without accents, in any case', () => {
    expect(find('Vasteras')).toEqual(['ESOW'])
    expect(find('VÄSTERÅS')).toEqual(['ESOW'])
    expect(find('vasteras hasslo')).toEqual(['ESOW'])
    expect(find('kobenhavn')).toEqual(['EKCH'])
    expect(find('Dusseldorf')).toEqual(['EDDL'])
    expect(find('düsseldorf')).toEqual(['EDDL'])
    expect(find('esso')).toEqual([])
    expect(find('ESSA')).toEqual(['ESSA'])
    expect(find('')).toHaveLength(4)
  })
})
