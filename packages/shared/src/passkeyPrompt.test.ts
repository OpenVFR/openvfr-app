import { describe, it, expect } from 'vitest'
import {
  INITIAL_PASSKEY_PROMPT_STATE as S0, PASSKEY_PROMPT_COOLDOWN_MS as DAY30,
  shouldOfferPasskey, canOfferNever, afterDismissal, parsePasskeyPromptState,
} from './passkeyPrompt'

describe('passkey prompt rules', () => {
  it('offers on first and, after one dismissal, on the next sign-in', () => {
    expect(shouldOfferPasskey(S0, 1000)).toBe(true)
    const s1 = afterDismissal(S0, 1000)
    expect(shouldOfferPasskey(s1, 1001)).toBe(true)
  })
  it('waits 30 days after the second dismissal', () => {
    const s2 = afterDismissal(afterDismissal(S0, 0), 5000)
    expect(shouldOfferPasskey(s2, 5000 + DAY30 - 1)).toBe(false)
    expect(shouldOfferPasskey(s2, 5000 + DAY30)).toBe(true)
  })
  it('offers "Don\'t ask again" only after a dismissal; it stops the offer for good', () => {
    expect(canOfferNever(S0)).toBe(false)
    const s1 = afterDismissal(S0, 0)
    expect(canOfferNever(s1)).toBe(true)
    const never = afterDismissal(s1, 10, true)
    expect(shouldOfferPasskey(never, 10 + 10 * DAY30)).toBe(false)
  })
  it('parses stored state tolerantly', () => {
    expect(parsePasskeyPromptState(null)).toEqual(S0)
    expect(parsePasskeyPromptState('{bad')).toEqual(S0)
    expect(parsePasskeyPromptState('{"dismissed":2,"lastAt":7,"never":true}')).toEqual({ dismissed: 2, lastAt: 7, never: true })
  })
})
