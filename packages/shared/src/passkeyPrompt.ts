/**
 * When to offer passkey registration, shared by web and native.
 *
 * The offer is made right after a successful email-code sign-in, to accounts
 * with no passkey yet. A dismissal is remembered per account on the device:
 * the next code sign-in asks again, after that at most once per
 * PASSKEY_PROMPT_COOLDOWN_MS. From the second dismissal on the offer carries a
 * "Don't ask again" choice, which stops it for good (Settings still has the
 * Add a passkey row).
 */
export const PASSKEY_PROMPT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000

export type PasskeyPromptState = {
  /** How many times the offer was dismissed ("Not now" or closing the OS sheet). */
  dismissed: number
  /** When it was last dismissed (ms since epoch). */
  lastAt: number
  /** "Don't ask again". */
  never: boolean
}

export const INITIAL_PASSKEY_PROMPT_STATE: PasskeyPromptState = { dismissed: 0, lastAt: 0, never: false }

export function shouldOfferPasskey(s: PasskeyPromptState, now: number): boolean {
  if (s.never) return false
  if (s.dismissed <= 1) return true
  return now - s.lastAt >= PASSKEY_PROMPT_COOLDOWN_MS
}

/** The "Don't ask again" choice is shown from the second dismissal on. */
export function canOfferNever(s: PasskeyPromptState): boolean {
  return s.dismissed >= 1
}

export function afterDismissal(s: PasskeyPromptState, now: number, never = false): PasskeyPromptState {
  return { dismissed: s.dismissed + 1, lastAt: now, never: s.never || never }
}

/** Tolerant parse of the stored value (anything unexpected = start over). */
export function parsePasskeyPromptState(raw: string | null | undefined): PasskeyPromptState {
  if (!raw) return INITIAL_PASSKEY_PROMPT_STATE
  try {
    const j = JSON.parse(raw) as Partial<PasskeyPromptState>
    return {
      dismissed: Number.isFinite(j.dismissed) ? Math.max(0, Number(j.dismissed)) : 0,
      lastAt:    Number.isFinite(j.lastAt) ? Number(j.lastAt) : 0,
      never:     j.never === true,
    }
  } catch { return INITIAL_PASSKEY_PROMPT_STATE }
}
