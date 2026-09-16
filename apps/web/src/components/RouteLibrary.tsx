import { useState, useRef, useEffect } from 'react'
import { useRouteLibrary } from '../db/useRouteDb'
import { useAircraftProfiles } from '../db/useAircraftProfiles'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride } from '../db/index'
import css from './RouteLibrary.module.css'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Relative time label, e.g. "2 min ago", "3 days ago". */
function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60)   return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60)   return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24)   return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30)   return `${d} day${d === 1 ? '' : 's'} ago`
  const mo = Math.floor(d / 30)
  return `${mo} mo ago`
}

/** Default save name: "DEP – DEST" from first/last waypoint names. */
function defaultRouteName(waypoints: RouteWaypoint[]): string {
  if (waypoints.length === 0) return 'New Route'
  const dep  = waypoints[0].name  ?? 'DEP'
  const dest = waypoints.length > 1 ? (waypoints[waypoints.length - 1].name ?? 'DEST') : ''
  return dest ? `${dep} – ${dest}` : dep
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  currentWaypoints:    RouteWaypoint[]
  currentLegOverrides: LegOverride[]
  currentAircraftId:   string
  onLoad:              (waypoints: RouteWaypoint[], legOverrides: LegOverride[], aircraftId: string) => void
  onClear:             () => void
}

/** Short label for a route's aircraft badge: registration if set, else name. */
function aircraftLabel(p: { name: string; registration: string }): string {
  return p.registration.trim() || p.name
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RouteLibrary({ currentWaypoints, currentLegOverrides, currentAircraftId, onLoad, onClear }: Props) {
  const { routes, saveRoute, loadRoute, deleteRoute, renameRoute } = useRouteLibrary()
  // Self-fetched (same pattern as AircraftLibrary) — used only to resolve
  // each saved route's stored aircraftId into a display badge, and to detect
  // when loading a route switches the active aircraft (see doLoad below).
  const { profiles: aircraftProfiles } = useAircraftProfiles()

  // Transient "switched aircraft" confirmation — set right after a route load
  // changes the active aircraft, auto-clears itself. Loading a route whose
  // stored aircraft differs from the one currently in use silently swaps
  // the active profile and recalculates fuel/W&B; this one-line confirmation
  // makes that swap visible instead of leaving it to happen unannounced.
  const [switchMsg, setSwitchMsg] = useState<string | null>(null)
  useEffect(() => {
    if (!switchMsg) return
    const id = setTimeout(() => setSwitchMsg(null), 5000)
    return () => clearTimeout(id)
  }, [switchMsg])

  // Save state
  const [saveName, setSaveName]   = useState('')
  const [saving,   setSaving]     = useState(false)

  // Search / sort (shown when > 5 routes)
  const [search, setSearch]       = useState('')
  const [sortBy, setSortBy]       = useState<'date' | 'name'>('date')

  // Rename state: id of the route being renamed + draft value
  const [renamingId,    setRenamingId]    = useState<string | null>(null)
  const [renameValue,   setRenameValue]   = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Confirm-before-load/new state
  const [pendingAction, setPendingAction] = useState<null | 'load' | 'new'>(null)
  const [pendingLoadId, setPendingLoadId] = useState<string | null>(null)

  // Delete confirm: id to confirm deletion
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingId) setTimeout(() => renameInputRef.current?.focus(), 30)
  }, [renamingId])

  // Update save name to reflect current route whenever it changes
  useEffect(() => {
    setSaveName(defaultRouteName(currentWaypoints))
  }, [currentWaypoints.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Filtered + sorted route list ─────────────────────────────────────────
  const filtered = routes
    .filter(r => !search || r.name.toLowerCase().includes(search.toLowerCase()))
    .sort(sortBy === 'date'
      ? (a, b) => b.updatedAt - a.updatedAt
      : (a, b) => a.name.localeCompare(b.name))

  // ── Save current route ────────────────────────────────────────────────────
  async function handleSave() {
    const name = saveName.trim() || defaultRouteName(currentWaypoints)
    if (currentWaypoints.length === 0) return
    setSaving(true)
    try {
      await saveRoute(name, currentWaypoints, currentLegOverrides, currentAircraftId)
      setSaveName('')
    } finally {
      setSaving(false)
    }
  }

  // ── Load a saved route ────────────────────────────────────────────────────
  function requestLoad(id: string) {
    if (currentWaypoints.length > 0) {
      setPendingAction('load')
      setPendingLoadId(id)
    } else {
      doLoad(id)
    }
  }

  async function doLoad(id: string) {
    const result = await loadRoute(id)
    if (result) {
      onLoad(result.waypoints, result.legOverrides, result.aircraftId)
      if (result.aircraftId && result.aircraftId !== currentAircraftId) {
        const p = aircraftProfiles.find(p => p.id === result.aircraftId)
        setSwitchMsg(p ? `Switched to ${aircraftLabel(p)}` : null)
      }
    }
    setPendingAction(null)
    setPendingLoadId(null)
  }

  // ── New Route ─────────────────────────────────────────────────────────────
  function requestNew() {
    if (currentWaypoints.length > 0) {
      setPendingAction('new')
    } else {
      onClear()
    }
  }

  // ── Rename ────────────────────────────────────────────────────────────────
  function startRename(id: string, currentName: string) {
    setRenamingId(id)
    setRenameValue(currentName)
  }

  async function commitRename() {
    if (!renamingId) return
    const name = renameValue.trim()
    if (name) await renameRoute(renamingId, name)
    setRenamingId(null)
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  async function confirmDelete(id: string) {
    await deleteRoute(id)
    setDeleteConfirmId(null)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={css.panel}>

      {/* ── Save current route ─────────────────────────────────────── */}
      <div className={css.saveRow}>
        <input
          className={css.saveInput}
          placeholder={currentWaypoints.length === 0 ? 'No route to save' : 'Route name…'}
          value={saveName}
          onChange={e => setSaveName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
          disabled={saving || currentWaypoints.length === 0}
          maxLength={80}
        />
        <button
          className={css.btn}
          onClick={handleSave}
          disabled={saving || currentWaypoints.length === 0}
        >
          {saving ? '…' : 'Save'}
        </button>
      </div>

      {/* ── Search + sort (shown when > 5 saved routes) ─────────────── */}
      {routes.length > 5 && (
        <div className={css.searchRow}>
          <input
            className={css.searchInput}
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button
            className={`${css.sortBtn}${sortBy === 'name' ? ` ${css.sortBtnActive}` : ''}`}
            title={sortBy === 'date' ? 'Sorting by date — click for name' : 'Sorting by name — click for date'}
            onClick={() => setSortBy(s => s === 'date' ? 'name' : 'date')}
          >
            {sortBy === 'date' ? '↕ date' : '↕ name'}
          </button>
        </div>
      )}

      {/* ── Saved routes list ───────────────────────────────────────── */}
      {filtered.length > 0 ? (
        <div className={css.list}>
          {filtered.map(r => (
            <div key={r.id} className={css.item}>
              {renamingId === r.id ? (
                <input
                  ref={renameInputRef}
                  className={css.renameInput}
                  value={renameValue}
                  placeholder="Route name"
                  title="Route name"
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  onBlur={commitRename}
                  maxLength={80}
                />
              ) : (
                <div className={css.itemInfo} onDoubleClick={() => startRename(r.id, r.name)}>
                  <span className={css.itemName}>{r.name}</span>
                  <span className={css.itemMeta}>
                    {r.waypoints.length} wpt · {timeAgo(r.updatedAt)}
                    {r.aircraftId && (() => {
                      const p = aircraftProfiles.find(p => p.id === r.aircraftId)
                      return p ? (
                        <span className={css.itemAircraft}> · {aircraftLabel(p)}</span>
                      ) : (
                        <span className={`${css.itemAircraft} ${css.itemAircraftMissing}`} title="Aircraft profile was deleted"> · ⚠ missing aircraft</span>
                      )
                    })()}
                  </span>
                </div>
              )}
              <div className={css.itemActions}>
                {deleteConfirmId === r.id ? (
                  <>
                    <button className={`${css.iconBtn} ${css.iconBtnDanger}`} onClick={() => confirmDelete(r.id)} title="Confirm delete">✓</button>
                    <button className={css.iconBtn} onClick={() => setDeleteConfirmId(null)} title="Cancel">✕</button>
                  </>
                ) : (
                  <>
                    <button className={css.iconBtn} onClick={() => requestLoad(r.id)} title="Load route">↳</button>
                    <button className={`${css.iconBtn} ${css.iconBtnDanger}`} onClick={() => setDeleteConfirmId(r.id)} title="Delete route">✕</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : routes.length === 0 ? (
        <p className={css.empty}>No saved routes</p>
      ) : (
        <p className={css.empty}>No matches</p>
      )}

      {/* ── Transient "switched aircraft" confirmation ──────────────── */}
      {switchMsg && <p className={css.switchNote}>✓ {switchMsg}</p>}

      {/* ── New Route button ────────────────────────────────────────── */}
      <div className={css.footer}>
        <button className={css.newBtn} onClick={requestNew}>+ New Route</button>
      </div>

      {/* ── Confirm dialog (unsaved changes) ────────────────────────── */}
      {pendingAction && (
        <div className={css.confirmOverlay}>
          <div className={css.confirmBox}>
            <p className={css.confirmMsg}>Current route has unsaved changes.</p>
            <div className={css.confirmActions}>
              <button
                className={css.confirmSave}
                onClick={async () => {
                  await saveRoute(defaultRouteName(currentWaypoints), currentWaypoints, currentLegOverrides, currentAircraftId)
                  if (pendingAction === 'load' && pendingLoadId) doLoad(pendingLoadId)
                  else { onClear(); setPendingAction(null) }
                }}
              >
                Save &amp; continue
              </button>
              <button
                className={css.confirmDiscard}
                onClick={() => {
                  if (pendingAction === 'load' && pendingLoadId) doLoad(pendingLoadId)
                  else { onClear(); setPendingAction(null) }
                }}
              >
                Discard
              </button>
              <button
                className={css.confirmCancel}
                onClick={() => { setPendingAction(null); setPendingLoadId(null) }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
