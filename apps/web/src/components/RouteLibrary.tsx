import { useState, useRef, useEffect } from 'react'
import { useRouteLibrary } from '../db/useRouteDb'
import { useAircraftProfiles } from '../db/useAircraftProfiles'
import { useSyncState } from '../hooks/useSync'
import { isRouteDirty } from '@open-vfr/shared/routeDirty'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride } from '../db/index'
import { suggestRouteName } from '@open-vfr/shared/suggestRouteName'
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
const defaultRouteName = suggestRouteName

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  currentWaypoints:    RouteWaypoint[]
  currentLegOverrides: LegOverride[]
  currentAircraftId:   string
  onLoad:              (waypoints: RouteWaypoint[], legOverrides: LegOverride[], aircraftId: string) => void
  onClear:             () => void
  /** Id of the saved route the working route was loaded from, or '' if untitled. */
  activeRouteId:          string
  onActiveRouteIdChange:  (id: string) => void
}

/** Short label for a route's aircraft badge: registration if set, else name. */
function aircraftLabel(p: { name: string; registration: string }): string {
  return p.registration.trim() || p.name
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RouteLibrary({
  currentWaypoints, currentLegOverrides, currentAircraftId, onLoad, onClear,
  activeRouteId, onActiveRouteIdChange,
}: Props) {
  const { routes, saveRoute, loadRoute, deleteRoute, renameRoute } = useRouteLibrary()
  // The saved-route row the working route is currently linked to, if any —
  // undefined both for "never linked" (activeRouteId === '') and for "was
  // linked but that row is gone" (e.g. deleted from another device).
  const linkedRoute = activeRouteId ? routes.find(r => r.id === activeRouteId) : undefined
  const dirty = isRouteDirty(
    { waypoints: currentWaypoints, legOverrides: currentLegOverrides, aircraftId: currentAircraftId },
    linkedRoute ? { waypoints: linkedRoute.waypoints, legOverrides: linkedRoute.legOverrides ?? [], aircraftId: linkedRoute.aircraftId ?? '' } : undefined,
  )
  // Self-fetched (same pattern as AircraftLibrary) — used only to resolve
  // each saved route's stored aircraftId into a display badge, and to detect
  // when loading a route switches the active aircraft (see doLoad below).
  const { profiles: aircraftProfiles } = useAircraftProfiles()
  // Reflects the last restUpsert/restDelete result across the whole app (not
  // just routes) -- 'idle' unless a push genuinely failed. Shown here rather
  // than as a persistent icon since a healthy sync needs no attention; only
  // surface it when there's actually something wrong.
  const syncPushState = useSyncState()

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

  // Save state. `saveAsOpen` is only relevant when linkedRoute is set — it
  // reveals the rename-style input for the explicit "Save As" action. When
  // unlinked (untitled route), the name input is always shown instead (see
  // render below) and doubles as "create new".
  const [saveName, setSaveName]   = useState('')
  const [saving,   setSaving]     = useState(false)
  const [saveAsOpen, setSaveAsOpen] = useState(false)

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

  // Update save name to reflect current route whenever it changes — only
  // while untitled (no linked route); a linked route's name comes from
  // `linkedRoute.name` directly, this input is just for the untitled case
  // and for the separate explicit Save As flow below.
  useEffect(() => {
    if (!linkedRoute) setSaveName(defaultRouteName(currentWaypoints))
  }, [currentWaypoints.length, linkedRoute]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Filtered + sorted route list ─────────────────────────────────────────
  const filtered = routes
    .filter(r => !search || r.name.toLowerCase().includes(search.toLowerCase()))
    .sort(sortBy === 'date'
      ? (a, b) => b.updatedAt - a.updatedAt
      : (a, b) => a.name.localeCompare(b.name))

  // ── Save current route (untitled route — creates or overwrites by name) ──
  async function handleSave() {
    const name = saveName.trim() || defaultRouteName(currentWaypoints)
    if (currentWaypoints.length === 0) return
    setSaving(true)
    try {
      const id = await saveRoute(name, currentWaypoints, currentLegOverrides, currentAircraftId)
      onActiveRouteIdChange(id)
      setSaveName('')
    } finally {
      setSaving(false)
    }
  }

  // ── Save current route in place (linked route — updates the same row) ────
  async function handleSaveInPlace() {
    if (!linkedRoute) return
    setSaving(true)
    try {
      await saveRoute(linkedRoute.name, currentWaypoints, currentLegOverrides, currentAircraftId, linkedRoute.id)
    } finally {
      setSaving(false)
    }
  }

  // ── Save As… (linked route — always creates a distinct new row, even if
  // the typed name happens to match the one being copied from) ─────────────
  function openSaveAs() {
    setSaveName(linkedRoute ? `${linkedRoute.name} (copy)` : defaultRouteName(currentWaypoints))
    setSaveAsOpen(true)
  }

  async function handleSaveAs() {
    const name = saveName.trim() || defaultRouteName(currentWaypoints)
    setSaving(true)
    try {
      const newId = crypto.randomUUID()
      const id = await saveRoute(name, currentWaypoints, currentLegOverrides, currentAircraftId, newId)
      onActiveRouteIdChange(id)
      setSaveAsOpen(false)
    } finally {
      setSaving(false)
    }
  }

  // ── Load a saved route ────────────────────────────────────────────────────
  function requestLoad(id: string) {
    if (dirty) {
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
      onActiveRouteIdChange(id)
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
    if (dirty) {
      setPendingAction('new')
    } else {
      onActiveRouteIdChange('')
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
    // Unlink the working route if it was pointing at the row just deleted —
    // otherwise "Editing: <name>" would keep showing a name that no longer
    // resolves to anything, with no way to Save in place.
    if (id === activeRouteId) onActiveRouteIdChange('')
    setDeleteConfirmId(null)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={css.panel}>

      {syncPushState !== 'idle' && (
        <p className={css.syncWarning} role="alert">
          {syncPushState === 'offline'
            ? '⚠ Offline — changes are saved locally and will sync when back online.'
            : '⚠ Cloud sync error — recent changes may not have saved to your account. They\'re safe locally; try again once online.'}
        </p>
      )}

      {linkedRoute ? (
        <>
          {/* ── Editing indicator + Save / Save As… ─────────────────── */}
          <div className={css.editingRow}>
            <span className={css.editingLabel}>
              Editing: <strong className={css.editingName}>{linkedRoute.name}</strong>
              {dirty && <span className={css.dirtyDot} title="Unsaved changes">●</span>}
            </span>
            <div className={css.editingActions}>
              <button className={css.btn} onClick={handleSaveInPlace} disabled={!dirty || saving} title={dirty ? 'Save changes to this route' : 'No changes to save'}>
                {saving ? '…' : 'Save'}
              </button>
              <button className={css.btn} onClick={openSaveAs} disabled={saving}>Save As…</button>
            </div>
          </div>
          {saveAsOpen && (
            <div className={css.saveRow}>
              <input
                className={css.saveInput}
                placeholder="New route name…"
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveAs(); if (e.key === 'Escape') setSaveAsOpen(false) }}
                disabled={saving}
                autoFocus
                maxLength={80}
              />
              <button className={css.btn} onClick={handleSaveAs} disabled={saving}>{saving ? '…' : 'Save'}</button>
              <button className={css.btn} onClick={() => setSaveAsOpen(false)} disabled={saving}>Cancel</button>
            </div>
          )}
        </>
      ) : (
        /* ── Save current route (untitled — create new / overwrite by name) ── */
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
      )}

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
                  // Linked route: save in place (same row, real name) instead
                  // of guessing a dep–dest name and creating/overwriting a
                  // possibly-unrelated row — this is exactly the bug this
                  // whole Save/Save As split exists to avoid.
                  if (linkedRoute) {
                    await saveRoute(linkedRoute.name, currentWaypoints, currentLegOverrides, currentAircraftId, linkedRoute.id)
                  } else {
                    const id = await saveRoute(defaultRouteName(currentWaypoints), currentWaypoints, currentLegOverrides, currentAircraftId)
                    onActiveRouteIdChange(id)
                  }
                  if (pendingAction === 'load' && pendingLoadId) doLoad(pendingLoadId)
                  else { onActiveRouteIdChange(''); onClear(); setPendingAction(null) }
                }}
              >
                Save &amp; continue
              </button>
              <button
                className={css.confirmDiscard}
                onClick={() => {
                  if (pendingAction === 'load' && pendingLoadId) doLoad(pendingLoadId)
                  else { onActiveRouteIdChange(''); onClear(); setPendingAction(null) }
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
