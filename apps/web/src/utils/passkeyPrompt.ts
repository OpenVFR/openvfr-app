/**
 * Browser-side state and account check for the "set up a passkey" offer shown
 * after an email-code sign-in (rules and the one-shot flag:
 * @open-vfr/shared/passkeyPrompt).
 */
import {
  afterDismissal, parsePasskeyPromptState, passkeyPromptStorageKey, type PasskeyPromptState,
} from '@open-vfr/shared/passkeyPrompt'
import { API_BASE_URL } from './env'

export function loadPromptState(userId: string): PasskeyPromptState {
  try { return parsePasskeyPromptState(localStorage.getItem(passkeyPromptStorageKey(userId))) }
  catch { return parsePasskeyPromptState(null) }
}

export function recordDismissal(userId: string, prev: PasskeyPromptState, never = false): void {
  try { localStorage.setItem(passkeyPromptStorageKey(userId), JSON.stringify(afterDismissal(prev, Date.now(), never))) }
  catch { /* storage blocked: the offer may repeat, Settings still has it */ }
}

/** False for accounts that cannot hold passkeys (shared test/review accounts). Unknown (offline, slow) counts as allowed. */
export async function fetchPasskeyAllowed(): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 5000)
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/account-flags`, { credentials: 'include', signal: ctl.signal })
    if (!res.ok) return true
    return (await res.json() as { passkeyAllowed?: boolean }).passkeyAllowed !== false
  } catch { return true } finally { clearTimeout(timer) }
}
