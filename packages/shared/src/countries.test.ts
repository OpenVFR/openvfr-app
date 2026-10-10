import { describe, it, expect } from 'vitest'
import { resolveSelectedCountries, toggleCountry, MAX_SELECTED_COUNTRIES } from './countries'

const se = { code: 'se', name: 'Sweden' }
const no = { code: 'no', name: 'Norway' }
const dk = { code: 'dk', name: 'Denmark' }

describe('resolveSelectedCountries', () => {
  it('keeps a saved country that is still available', () => {
    expect(resolveSelectedCountries(['no'], [se, no, dk])).toEqual(['no'])
  })
  it('never returns more than the limit', () => {
    expect(resolveSelectedCountries(['se', 'no', 'dk'], [se, no, dk])).toHaveLength(MAX_SELECTED_COUNTRIES)
    expect(resolveSelectedCountries(['se', 'no'], null)).toHaveLength(MAX_SELECTED_COUNTRIES)
  })
  it('drops countries no longer available', () => {
    expect(resolveSelectedCountries(['no', 'se'], [se])).toEqual(['se'])
  })
  it('falls back to the default country when nothing saved is available', () => {
    expect(resolveSelectedCountries(['fi'], [no, se])).toEqual(['se'])
  })
  it('falls back to the first available when the default is not served', () => {
    expect(resolveSelectedCountries([], [no, dk])).toEqual(['no'])
  })
  it('empty when the server serves nothing', () => {
    expect(resolveSelectedCountries(['se'], [])).toEqual([])
  })
  it('trusts the saved selection while the list is unknown', () => {
    expect(resolveSelectedCountries(['no'], null)).toEqual(['no'])
    expect(resolveSelectedCountries([], null)).toEqual(['se'])
  })
})

describe('toggleCountry', () => {
  it('with a limit of one, picking replaces the selection', () => {
    if (MAX_SELECTED_COUNTRIES !== 1) return
    expect(toggleCountry(['se'], 'no')).toEqual(['no'])
    expect(toggleCountry(['se'], 'se')).toEqual(['se'])
  })
})
