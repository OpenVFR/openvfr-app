import { describe, it, expect } from 'vitest'
import { contactName } from './AerodromePopup'

describe('contactName', () => {
  it('names a website by its club', () => {
    expect(contactName({ type: 'URL', address: 'gyroflyg.se', label: 'Gyroflyg' })).toBe('Gyroflyg')
    expect(contactName({ type: 'URL', address: 'gyroflyg.se', label: '  Gyroflyg  ' })).toBe('Gyroflyg')
  })
  it('shows nothing without a name, for other types (their label is the source) or when it repeats the address', () => {
    expect(contactName({ type: 'URL', address: 'gyroflyg.se' })).toBeNull()
    expect(contactName({ type: 'URL', address: 'gyroflyg.se', label: '' })).toBeNull()
    expect(contactName({ type: 'PHONE', address: '+46 8 000 00', label: 'LFV eAIP Sweden' })).toBeNull()
    expect(contactName({ type: 'URL', address: 'www.gyroflyg.se', label: 'https://gyroflyg.se/' })).toBeNull()
  })
})
