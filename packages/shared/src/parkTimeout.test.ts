import { describe, it, expect } from 'vitest'
import { parseParkTimeout, parkTimeoutLabel, PARK_TIMEOUT_DEFAULT } from './parkTimeout'

describe('parkTimeout', () => {
  it('parses valid values (string or number)', () => {
    expect(parseParkTimeout('600')).toBe(600)
    expect(parseParkTimeout(0)).toBe(0)
    expect(parseParkTimeout(1800)).toBe(1800)
  })
  it('falls back to default for invalid values', () => {
    expect(parseParkTimeout('abc')).toBe(PARK_TIMEOUT_DEFAULT)
    expect(parseParkTimeout(45)).toBe(PARK_TIMEOUT_DEFAULT)
    expect(parseParkTimeout(undefined)).toBe(PARK_TIMEOUT_DEFAULT)
  })
  it('labels', () => {
    expect(parkTimeoutLabel(0)).toBe('Per leg')
    expect(parkTimeoutLabel(60)).toBe('1 min')
    expect(parkTimeoutLabel(1800)).toBe('30 min')
  })
})
