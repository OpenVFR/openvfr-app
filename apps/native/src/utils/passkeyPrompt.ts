/**
 * Device-side state and account check for the "set up a passkey" offer shown
 * after an email-code sign-in (rules and the one-shot flag:
 * @open-vfr/shared/passkeyPrompt).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  afterDismissal, parsePasskeyPromptState, passkeyPromptStorageKey, type PasskeyPromptState,
} from '@open-vfr/shared/passkeyPrompt'
import { API_BASE } from '../config'
import { authHeaders } from './authClient'

export async function loadPromptState(userId: string): Promise<PasskeyPromptState> {
  try { return parsePasskeyPromptState(await AsyncStorage.getItem(passkeyPromptStorageKey(userId))) }
  catch { return parsePasskeyPromptState(null) }
}

export async function recordDismissal(userId: string, prev: PasskeyPromptState, never = false): Promise<void> {
  await AsyncStorage.setItem(passkeyPromptStorageKey(userId), JSON.stringify(afterDismissal(prev, Date.now(), never))).catch(() => {})
}

/** False for accounts that cannot hold passkeys (shared test/review accounts). Unknown (offline, slow) counts as allowed. */
export async function fetchPasskeyAllowed(): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 5000)
  try {
    const res = await fetch(`${API_BASE}/api/auth/account-flags`, { headers: await authHeaders(), signal: ctl.signal })
    if (!res.ok) return true
    return (await res.json() as { passkeyAllowed?: boolean }).passkeyAllowed !== false
  } catch { return true } finally { clearTimeout(timer) }
}
