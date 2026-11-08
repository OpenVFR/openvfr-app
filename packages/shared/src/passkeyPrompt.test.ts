import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  INITIAL_PASSKEY_PROMPT_STATE as S0, PASSKEY_PROMPT_COOLDOWN_MS as DAY30,
  shouldOfferPasskey, canOfferNever, afterDismissal, parsePasskeyPromptState,
  startPasskeyOffer, markOtpSignIn, peekOtpSignIn, consumeOtpSignIn,
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

describe('startPasskeyOffer', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const deps = (over: Partial<Parameters<typeof startPasskeyOffer>[0]> = {}) => ({
    loadState: () => S0,
    accountAllowed: async () => true,
    countPasskeys: async () => 0 as number | null,
    onOffer: vi.fn(),
    ...over,
  })
  beforeEach(() => { consumeOtpSignIn() })

  it('does nothing without a code sign-in', async () => {
    const d = deps(); startPasskeyOffer(d); await flush()
    expect(d.onOffer).not.toHaveBeenCalled()
  })
  it('offers to an account with no passkey and consumes the flag', async () => {
    markOtpSignIn(); const d = deps(); startPasskeyOffer(d); await flush()
    expect(d.onOffer).toHaveBeenCalledWith(S0)
    expect(peekOtpSignIn()).toBe(false)
  })
  it('does not offer when the passkey count is unknown or non-zero', async () => {
    for (const count of [null, 1]) {
      markOtpSignIn(); const d = deps({ countPasskeys: async () => count }); startPasskeyOffer(d); await flush()
      expect(d.onOffer).not.toHaveBeenCalled()
    }
  })
  it('does not offer when a check throws or the platform is not ready', async () => {
    markOtpSignIn(); const a = deps({ accountAllowed: async () => { throw new Error('offline') } }); startPasskeyOffer(a); await flush()
    expect(a.onOffer).not.toHaveBeenCalled()
    markOtpSignIn(); const b = deps({ platformReady: async () => false }); startPasskeyOffer(b); await flush()
    expect(b.onOffer).not.toHaveBeenCalled()
  })
  it('an aborted run leaves the flag for the next run', async () => {
    markOtpSignIn(); const d = deps(); const stop = startPasskeyOffer(d); stop(); await flush()
    expect(d.onOffer).not.toHaveBeenCalled()
    expect(peekOtpSignIn()).toBe(true)
  })
})
