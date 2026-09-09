/**
 * AccountBadge — avatar tab sitting above the SideDrawer toggle.
 * Collapsed: shows initials.
 * Expanded: compact flyout with "Profile" (opens ProfilePanel) and "Sign out".
 */

import { useState, useRef, useEffect } from 'react'
import type { AuthState } from '../hooks/useAuth'
import styles from './AccountBadge.module.css'

interface Props {
  auth:          AuthState
  onOpenProfile: () => void
}

export default function AccountBadge({ auth, onOpenProfile }: Props) {
  if (!auth.user) return null

  const [open,   setOpen]   = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const nameParts = auth.user.name.trim().split(/\s+/).filter(Boolean)
  const initials = nameParts.length >= 2
    ? (nameParts[0][0]! + nameParts[nameParts.length - 1][0]!).toUpperCase()
    : nameParts.length === 1
      ? nameParts[0][0]!.toUpperCase()
      : (auth.user.email[0] ?? '?').toUpperCase()

  // Close flyout when clicking outside.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        className={styles.tab}
        onClick={() => setOpen(o => !o)}
        title={`Signed in as ${auth.user.email}`}
        aria-label="Account menu"
        type="button"
      >
        {initials}
      </button>

      {open && (
        <div className={styles.flyout}>
          <p className={styles.email}>{auth.user.email}</p>
          <div className={styles.divider} />
          <button
            className={styles.menuItem}
            onClick={() => { setOpen(false); onOpenProfile() }}
            type="button"
          >
            Profile &amp; passkeys
          </button>
          <button
            className={`${styles.menuItem} ${styles.menuItemDanger}`}
            onClick={() => { setOpen(false); void auth.signOut() }}
            type="button"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

