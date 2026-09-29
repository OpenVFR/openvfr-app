/**
 * Local data belongs to one account at a time.
 *
 * Routes, aircraft, user waypoints and flight logs live in AsyncStorage and
 * the sync hooks upload what is local after sign-in. Without a boundary,
 * signing in as a second account on the same device uploaded the first
 * account's private data into it.
 *
 *  - `ovfr:syncOwner` records the account the local data belongs to.
 *  - claimLocalData(userId) runs before an account is treated as signed in:
 *    a different owner's data is wiped first. Data created while signed out
 *    (no owner) is kept and belongs to the first account that signs in.
 *  - Sign-out wipes immediately (the cloud copy is the source of truth).
 *
 * Settings are per-device and are not wiped.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'

const OWNER_KEY = 'ovfr:syncOwner'
const PRIVATE_KEYS = [
  'ovfr:routes',
  'ovfr:aircraft_profiles',
  'ovfr:user_waypoints',
  'ovfr:flight_logs',
]

export async function wipePrivateLocalData(): Promise<void> {
  await AsyncStorage.removeMany([...PRIVATE_KEYS, OWNER_KEY]).catch(() => {})
}

export async function claimLocalData(userId: string): Promise<void> {
  const owner = await AsyncStorage.getItem(OWNER_KEY).catch(() => null)
  if (owner && owner !== userId) await wipePrivateLocalData()
  await AsyncStorage.setItem(OWNER_KEY, userId).catch(() => {})
}
