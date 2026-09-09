/**
 * requestBlePermissions — Android 12+ requires runtime grants for
 * BLUETOOTH_SCAN/BLUETOOTH_CONNECT (they're "dangerous" permissions, unlike
 * the old BLUETOOTH/BLUETOOTH_ADMIN which were normal/install-time only).
 * Without this, startDeviceScan() silently returns zero devices — no
 * error, no exception — which is exactly the "app doesn't find it but the
 * vendor's own app does" symptom: the vendor app already requested/has the
 * grant, ours never asked.
 *
 * Pre-Android-12 (API < 31) devices instead need ACCESS_FINE_LOCATION at
 * runtime for BLE scanning (a long-standing AOSP quirk, unrelated to GPS) —
 * request that as the fallback path. This app already requests
 * ACCESS_FINE_LOCATION for GPS elsewhere, but BLE scanning has its own
 * independent runtime-permission requirement so don't assume it's already
 * granted.
 */

import { PermissionsAndroid, Platform } from 'react-native'

export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true

  const apiLevel = Platform.Version as number

  if (apiLevel >= 31) {
    const granted = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ])
    return (
      granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED &&
      granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED
    )
  }

  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  )
  return granted === PermissionsAndroid.RESULTS.GRANTED
}
