/**
 * sessionToken — the better-auth bearer token, kept in the platform's secure
 * storage (iOS Keychain / Android Keystore-encrypted prefs via
 * expo-secure-store), never in AsyncStorage (a plain, unencrypted file).
 *
 * Captured from every API response (authClient.ts onSuccess) and sent as
 * `Authorization: Bearer` by authHeaders(). Held in memory after the first
 * read: authHeaders() runs on almost every request, a Keychain round-trip
 * each time would be slow.
 *
 * AFTER_FIRST_UNLOCK: flight tracking keeps the app running with the screen
 * locked, and traffic / sync requests made then still need the token.
 *
 * Builds before this module stored the token in AsyncStorage under the same
 * key; the first read moves it over and deletes the old copy, so an update
 * does not sign anyone out.
 */
import * as SecureStore from 'expo-secure-store'
import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = 'better-auth-token'
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }

/** undefined = not read yet; null = no token. */
let cached: string | null | undefined
/** Bumped on every set/clear, so a slow first read can't overwrite a newer value. */
let generation = 0
let loading: Promise<string | null> | null = null

async function load(): Promise<string | null> {
  const gen = generation
  let token = await SecureStore.getItemAsync(KEY, OPTIONS).catch(() => null)
  const legacy = await AsyncStorage.getItem(KEY).catch(() => null)
  if (legacy) {
    if (!token) {
      token = legacy
      // Unless a newer token was stored while this read was in flight.
      if (gen === generation) await SecureStore.setItemAsync(KEY, legacy, OPTIONS).catch(() => {})
    }
    await AsyncStorage.removeItem(KEY).catch(() => {})
  }
  if (gen === generation) cached = token ?? null
  return cached ?? null
}

export async function getSessionToken(): Promise<string | null> {
  if (cached !== undefined) return cached
  loading ??= load().finally(() => { loading = null })
  return loading
}

export async function setSessionToken(token: string): Promise<void> {
  if (cached === token) return
  generation++
  cached = token
  await SecureStore.setItemAsync(KEY, token, OPTIONS).catch((e) => {
    console.warn('[auth] could not store session token:', e instanceof Error ? e.message : String(e))
  })
}

export async function clearSessionToken(): Promise<void> {
  generation++
  cached = null
  await SecureStore.deleteItemAsync(KEY, OPTIONS).catch(() => {})
  await AsyncStorage.removeItem(KEY).catch(() => {})
}
