import { Alert, Linking } from 'react-native'

/** Open a link (a publisher's page, a mail app) and tell the pilot when nothing can open it: `Linking.openURL` rejects with no
 *  message of its own, e.g. on a tablet without a mail app. `fallback` is shown in the alert (an address to copy by hand). */
export function openExternal(url: string, what: string, fallback?: string): void {
  Linking.openURL(url).catch(() => {
    Alert.alert(`Could not open ${what}`, fallback ? `No app on this device could open it. ${fallback}` : 'No app on this device could open it.')
  })
}
