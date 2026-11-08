/**
 * When to offer passkey registration, shared by web and native.
 *
 * The offer is made right after a successful email-code sign-in, to accounts
 * with no passkey yet. A dismissal is remembered per account on the device:
 * the next code sign-in asks again, after that at most once per
 * PASSKEY_PROMPT_COOLDOWN_MS. From the second offer on (after one dismissal) it
 * carries a "Don't ask again" choice, which stops it for good (Settings still has the
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

/** The "Don't ask again" choice is shown from the second offer on, i.e. after one dismissal. */
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

/** Storage key for one account's prompt state (same on web and native). */
export const passkeyPromptStorageKey = (userId: string): string => `ovfr:passkeyPrompt:${userId}`

// One-shot "a code sign-in just succeeded" flag, so restoring a stored session
// at start never triggers the offer. Read it with peek and consume it only
// once the decision is final: effects can run twice (StrictMode) or be
// aborted before they decide.
let otpSignInPending = false
export function markOtpSignIn(): void { otpSignInPending = true }
export function peekOtpSignIn(): boolean { return otpSignInPending }
export function consumeOtpSignIn(): void { otpSignInPending = false }

export type PasskeyOfferDeps = {
  /** The account's saved prompt state. */
  loadState: () => PasskeyPromptState | Promise<PasskeyPromptState>
  /** The platform can hold a passkey (e.g. a built-in authenticator). Omit when always true. */
  platformReady?: () => Promise<boolean>
  /** False for accounts that cannot hold passkeys (shared test / review accounts). */
  accountAllowed: () => Promise<boolean>
  /** How many passkeys the account has; null = could not tell (offline, server error). */
  countPasskeys: () => Promise<number | null>
  onOffer: (state: PasskeyPromptState) => void
  now?: () => number
}

/**
 * Decide whether to offer a passkey right after a code sign-in, once. Returns the
 * effect cleanup. The order matters and is easy to get wrong, so both apps use
 * this: peek the one-shot flag, decide, and consume the flag only when the run was
 * not aborted (StrictMode runs effects twice). Any failed check means no offer: an
 * unknown passkey count must never read as "none".
 */
export function startPasskeyOffer(deps: PasskeyOfferDeps): () => void {
  if (!peekOtpSignIn()) return () => {}
  let alive = true
  void (async () => {
    let offer: PasskeyPromptState | null = null
    try {
      const saved = await deps.loadState()
      if (
        shouldOfferPasskey(saved, (deps.now ?? Date.now)()) &&
        (deps.platformReady ? await deps.platformReady() : true) &&
        await deps.accountAllowed() &&
        (await deps.countPasskeys()) === 0
      ) offer = saved
    } catch { /* unexpected: stay silent, Settings still has the entry */ }
    if (!alive) return          // aborted before deciding: leave the flag for the next run
    consumeOtpSignIn()
    if (offer) deps.onOffer(offer)
  })()
  return () => { alive = false }
}
