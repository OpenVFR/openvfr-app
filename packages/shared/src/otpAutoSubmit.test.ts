import { describe, it, expect } from 'vitest'
import { shouldAutoSubmitOtp } from './otpAutoSubmit'

describe('shouldAutoSubmitOtp', () => {
  it('submits when autofill/paste fills exactly 6 digits in one change', () => {
    expect(shouldAutoSubmitOtp('', '123456')).toBe(true)
    expect(shouldAutoSubmitOtp('12', '123456')).toBe(true)
  })
  it('never submits typed digits, including the 6th', () => {
    expect(shouldAutoSubmitOtp('12345', '123456')).toBe(false)
    expect(shouldAutoSubmitOtp('1234', '12345')).toBe(false)
  })
  it('ignores longer codes (review account) and deletions', () => {
    expect(shouldAutoSubmitOtp('', '1234567890')).toBe(false)
    expect(shouldAutoSubmitOtp('123456', '1234567')).toBe(false)
    expect(shouldAutoSubmitOtp('1234567', '123456')).toBe(false)
  })
})
