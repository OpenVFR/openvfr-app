/**
 * Account panel section "Get the app": OpenVFR is also an iOS and Android app (offline maps), and the account
 * keeps routes, aircraft, places and flight logs in sync between all of them.
 */
import { APP_STORES, SYNC_NOTE } from '@open-vfr/shared/appAvailability'
import styles from './ProfilePanel.module.css'

export default function AppsSection() {
  return (
    <div className={styles.section}>
      <p className={styles.label}>Also as an app</p>
      <p className={styles.statusMsg}>
        OpenVFR is also an app for iOS and Android, with offline maps. {SYNC_NOTE}
      </p>
      <p className={styles.statusMsg}>
        <a className={styles.inlineLink} href={APP_STORES.ios.url} target="_blank" rel="noopener noreferrer">{APP_STORES.ios.name}</a>
        {' · '}
        <a className={styles.inlineLink} href={APP_STORES.android.url} target="_blank" rel="noopener noreferrer">{APP_STORES.android.name}</a>
      </p>
    </div>
  )
}
