/**
 * ProfilePanel — full-screen modal for account management.
 *
 * Sections:
 *   • Display name (editable inline)
 *   • Passkeys — list with revoke + register new
 */

import { useState, useEffect, useRef } from 'react'
import type { AuthState, PasskeyInfo } from '../hooks/useAuth'
import styles from './ProfilePanel.module.css'

interface Props {
  auth:    AuthState
  onClose: () => void
}

export default function ProfilePanel({ auth, onClose }: Props) {
  const [name,        setName]        = useState(auth.user?.name ?? '')
  const [nameSaved,   setNameSaved]   = useState(false)
  const [nameError,   setNameError]   = useState<string | null>(null)
  const [nameBusy,    setNameBusy]    = useState(false)

  const [passkeys,    setPasskeys]    = useState<PasskeyInfo[]>([])
  const [pkLoading,   setPkLoading]   = useState(true)
  const [pkError,     setPkError]     = useState<string | null>(null)

  const [registering, setRegistering] = useState(false)
  const [pkName,      setPkName]      = useState('')
  const [pkBusy,      setPkBusy]      = useState(false)
  const pkNameRef = useRef<HTMLInputElement>(null)

  const [deleteConfirming, setDeleteConfirming] = useState(false)
  const [deleteBusy,       setDeleteBusy]       = useState(false)
  const [deleteError,      setDeleteError]      = useState<string | null>(null)
  const [deleteSent,       setDeleteSent]       = useState(false)

  // Load passkeys on mount.
  useEffect(() => {
    void auth.listPasskeys()
      .then(setPasskeys)
      .catch((err: unknown) => setPkError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setPkLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Focus passkey name input when registering step opens.
  useEffect(() => {
    if (registering) pkNameRef.current?.focus()
  }, [registering])

  // Close on Escape.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSaveName = async () => {
    const trimmed = name.trim()
    if (!trimmed) { setNameError('Name cannot be empty'); return }
    setNameBusy(true)
    setNameError(null)
    try {
      await auth.updateUser({ name: trimmed })
      setNameSaved(true)
      setTimeout(() => setNameSaved(false), 2500)
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setNameBusy(false)
    }
  }

  const handleRegisterPasskey = async () => {
    const name = pkName.trim()
    setPkBusy(true)
    setRegistering(false)
    setPkName('')
    setPkError(null)
    try {
      await auth.registerPasskey(name || undefined)
      // Refresh the list.
      const updated = await auth.listPasskeys()
      setPasskeys(updated)
    } catch (err) {
      setPkError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setPkBusy(false)
    }
  }

  const handleRequestDeletion = async () => {
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await auth.requestAccountDeletion()
      setDeleteConfirming(false)
      setDeleteSent(true)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to request account deletion')
    } finally {
      setDeleteBusy(false)
    }
  }

  const handleDeletePasskey = async (id: string) => {
    setPkError(null)
    try {
      await auth.deletePasskey(id)
      setPasskeys(prev => prev.filter(p => p.id !== id))
    } catch (err) {
      setPkError(err instanceof Error ? err.message : 'Failed to revoke')
    }
  }

  const nameChanged = name.trim() !== (auth.user?.name ?? '').trim()

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label="Profile">
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.title}>Profile</h2>
          <button className={styles.closeBtn} onClick={onClose} type="button" aria-label="Close">✕</button>
        </div>

        {/* Email (read-only) */}
        <div className={styles.section}>
          <p className={styles.label}>Email</p>
          <p className={styles.emailValue}>{auth.user?.email}</p>
        </div>

        <div className={styles.sectionDivider} />

        {/* Display name */}
        <div className={styles.section}>
          <p className={styles.label}>Display name</p>
          <div className={styles.nameRow}>
            <input
              className={styles.nameInput}
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setNameError(null) }}
              onKeyDown={(e) => e.key === 'Enter' && nameChanged && !nameBusy && void handleSaveName()}
              disabled={nameBusy}
              maxLength={80}
              aria-label="Display name"
              placeholder="Firstname Lastname"
            />
            <button
              className={styles.btnSave}
              onClick={() => void handleSaveName()}
              disabled={nameBusy || !nameChanged}
              type="button"
            >
              {nameSaved ? '✓ Saved' : 'Save'}
            </button>
          </div>
          {nameError && <p className={styles.errorMsg}>{nameError}</p>}
        </div>

        <div className={styles.sectionDivider} />

        {/* Passkeys */}
        <div className={styles.section}>
          <div className={styles.passkeyHeader}>
            <p className={styles.label}>Passkeys</p>
            {!registering && !pkBusy && (
              <button className={styles.btnAdd} onClick={() => setRegistering(true)} type="button">
                + Add passkey
              </button>
            )}
          </div>

          {registering && (
            <div className={styles.registerBlock}>
              <input
                ref={pkNameRef}
                className={styles.pkNameInput}
                type="text"
                placeholder="e.g. DELL laptop, Samsung phone"
                maxLength={50}
                value={pkName}
                onChange={(e) => setPkName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter')  void handleRegisterPasskey()
                  if (e.key === 'Escape') { setRegistering(false); setPkName('') }
                }}
              />
              <div className={styles.registerActions}>
                <button className={styles.btnSave} onClick={() => void handleRegisterPasskey()} type="button">
                  Register
                </button>
                <button className={styles.btnCancel} onClick={() => { setRegistering(false); setPkName('') }} type="button">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {pkBusy && <p className={styles.statusMsg}>Waiting for passkey…</p>}
          {pkError && <p className={styles.errorMsg}>{pkError}</p>}

          {pkLoading ? (
            <p className={styles.statusMsg}>Loading…</p>
          ) : passkeys.length === 0 ? (
            <p className={styles.emptyMsg}>No passkeys registered yet.</p>
          ) : (
            <ul className={styles.passkeyList}>
              {passkeys.map((pk) => (
                <li key={pk.id} className={styles.passkeyItem}>
                  <div className={styles.passkeyInfo}>
                    <span className={styles.passkeyName}>{pk.name ?? 'Unnamed passkey'}</span>
                    {pk.createdAt && (
                      <span className={styles.passkeyDate}>
                        Added {pk.createdAt.toLocaleDateString('sv-SE')}
                      </span>
                    )}
                  </div>
                  <button
                    className={styles.btnRevoke}
                    onClick={() => void handleDeletePasskey(pk.id)}
                    type="button"
                    aria-label={`Revoke passkey ${pk.name ?? ''}`}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={styles.sectionDivider} />

        {/* Sign out */}
        <div className={styles.section}>
          <button
            className={styles.btnSignOut}
            onClick={() => { onClose(); void auth.signOut() }}
            type="button"
          >
            Sign out
          </button>
        </div>

        <div className={styles.sectionDivider} />

        {/* Delete account */}
        <div className={styles.section}>
          {deleteSent ? (
            <p className={styles.deleteSentMsg}>
              Check your email ({auth.user?.email}) for a link to confirm deletion.
              Your account and all associated data (routes, aircraft profiles,
              waypoints, settings, flight logs) will be permanently deleted once
              you click it. The link expires in 24 hours.
            </p>
          ) : deleteConfirming ? (
            <div className={styles.deleteConfirm}>
              <p className={styles.deleteConfirmText}>
                This permanently deletes your account and all associated data
                (routes, aircraft profiles, waypoints, settings, flight logs).
                We'll email a confirmation link — nothing is deleted until you
                click it.
              </p>
              {deleteError && <p className={styles.errorMsg}>{deleteError}</p>}
              <div className={styles.deleteConfirmActions}>
                <button
                  className={styles.btnDeleteConfirm}
                  onClick={() => void handleRequestDeletion()}
                  disabled={deleteBusy}
                  type="button"
                >
                  {deleteBusy ? 'Sending…' : 'Send deletion email'}
                </button>
                <button
                  className={styles.btnCancel}
                  onClick={() => { setDeleteConfirming(false); setDeleteError(null) }}
                  disabled={deleteBusy}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className={styles.deleteLink}
              onClick={() => setDeleteConfirming(true)}
              type="button"
            >
              Delete account and all data
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
