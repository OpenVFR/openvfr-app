import { describe, it, expect } from 'vitest'
import { resolveSelectedCountries, toggleCountry } from './countries'

const se = { code: 'se', name: 'Sweden' }
const no = { code: 'no', name: 'Norway' }
const dk = { code: 'dk', name: 'Denmark' }

describe('resolveSelectedCountries', () => {
  it('keeps saved countries that are still available', () => {
    expect(resolveSelectedCountries(['se', 'no'], [se, no, dk])).toEqual(['se', 'no'])
  })
  it('drops countries no longer available', () => {
    expect(resolveSelectedCountries(['se', 'no'], [se])).toEqual(['se'])
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
  it('adds and removes', () => {
    expect(toggleCountry(['se'], 'no')).toEqual(['se', 'no'])
    expect(toggleCountry(['se', 'no'], 'se')).toEqual(['no'])
  })
  it('never removes the last country', () => {
    expect(toggleCountry(['se'], 'se')).toEqual(['se'])
  })
})
