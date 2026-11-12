/**
 * Where OpenVFR is available, for the hints that point from one app to the others: the web Account panel
 * names the iOS and Android apps, native Settings -> Account names the web app. Store links match the
 * website's download buttons (openvfr-site: Cta.astro).
 */
export const WEB_APP = {
  name: 'Web app',
  url: 'https://app.openvfr.org',
  host: 'app.openvfr.org',
} as const

export const APP_STORES = {
  ios: { name: 'App Store', url: 'https://apps.apple.com/app/id6808581880' },
  android: { name: 'Google Play', url: 'https://play.google.com/store/apps/details?id=org.openvfr.app' },
} as const

/** What the account keeps in sync (the cloud-sync collections: routes, aircraft, places, flight logs). */
export const SYNCED_DATA = 'routes, aircraft, places and flight logs'

/** One sentence for both hints. */
export const SYNC_NOTE = `Your ${SYNCED_DATA} are the same on the web, iOS and Android when you sign in with the same account.`
