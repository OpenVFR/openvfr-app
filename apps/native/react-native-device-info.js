// Expo-compatible shim for `react-native-device-info`, aliased in
// babel.config.js. sp-react-native-in-app-updates (force-update gate, see
// src/hooks/useForceUpdate.ts) depends on that package internally purely to
// read the running app's bundle id + version -- both already available
// from `expo-constants` in a managed/prebuild Expo app, so no real native
// module (and no extra prebuild config) is needed for this.
import Constants from 'expo-constants'

export const getBundleId = () => {
  return Constants.expoConfig?.ios?.bundleIdentifier
    ?? Constants.expoConfig?.android?.package
    ?? ''
}

export const getVersion = () => {
  return Constants.expoConfig?.version ?? '0.0.0'
}

export default {
  getBundleId,
  getVersion,
}
