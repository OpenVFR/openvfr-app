import { useState, useEffect, useId, useRef } from 'react'
import type { UserWaypointDocType } from '../db/index'
import type { RouteWaypoint } from '../utils/routeCalc'
import { waypointsToGpx, gpxToWaypoints } from '@open-vfr/shared/gpx'
import css from './UserWaypoints.module.css'

// ── GPX helpers ───────────────────────────────────────────────────────────────

function toGpx(waypoints: UserWaypointDocType[]): string {
  return waypointsToGpx(waypoints.map(w => ({ name: w.name, lat: w.lat, lng: w.lng, folder: w.folder })))
}

function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ── Blank form ────────────────────────────────────────────────────────────────

interface NewWpForm {
  name: string
  lat: string
  lng: string
  folder: string
}

const BLANK: NewWpForm = { name: '', lat: '', lng: '', folder: '' }

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  waypoints: UserWaypointDocType[]
  pendingCoords: { lng: number; lat: number } | null
  folderVisibility: Record<string, boolean>
  onCoordsConsumed: () => void
  onStartPlace: () => void
  onSave: (wp: Omit<UserWaypointDocType, 'id' | 'updatedAt'>) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  onMoveFolder: (id: string, folder: string) => void
  onAddToRoute: (wp: RouteWaypoint) => void
  onFolderVisChange: (folder: string, visible: boolean) => void
}

export default function UserWaypoints({
  waypoints, pendingCoords, folderVisibility,
  onCoordsConsumed, onStartPlace,
  onSave, onDelete, onRename, onMoveFolder: _onMoveFolder,
  onAddToRoute, onFolderVisChange,
}: Props) {
  const formId = useId()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<NewWpForm>(BLANK)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  // Fill form when "pick on map" coords arrive.
  useEffect(() => {
    if (pendingCoords) {
      setForm(f => ({
        ...f,
        lat: pendingCoords.lat.toFixed(5),
        lng: pendingCoords.lng.toFixed(5),
      }))
      setShowForm(true)
      onCoordsConsumed()
    }
  }, [pendingCoords, onCoordsConsumed])

  // All folder names (empty string → "Unfiled").
  const folders = Array.from(new Set(['', ...waypoints.map(w => w.folder)]))

  const wpByFolder = (folder: string) => waypoints.filter(w => w.folder === folder)
  const isFolderVisible = (f: string) => folderVisibility[f] !== false
  const existingFolders = folders.filter(Boolean)

  function submit() {
    const lat = parseFloat(form.lat)
    const lng = parseFloat(form.lng)
    if (!form.name.trim() || isNaN(lat) || isNaN(lng)) return
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return
    onSave({ name: form.name.trim(), lat, lng, folder: form.folder.trim() })
    setForm(BLANK)
    setShowForm(false)
  }

  function exportGpx() {
    downloadBlob('user-waypoints.gpx', toGpx(waypoints), 'application/gpx+xml')
  }

  const fileInputRef = useRef<HTMLInputElement>(null)

  async function importGpx(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const imported = gpxToWaypoints(text)
      for (const wp of imported) {
        onSave({ name: wp.name, lat: wp.lat, lng: wp.lng, folder: wp.folder ?? '' })
      }
    } catch { /* invalid GPX — ignore silently */ }
  }

  const latValid = !isNaN(parseFloat(form.lat))
  const lngValid = !isNaN(parseFloat(form.lng))
  const canSave = form.name.trim().length > 0 && latValid && lngValid

  return (
    <div className={css.panel}>
      {/* Toolbar */}
      <div className={css.toolbar}>
        <button
          className={css.addBtn}
          onClick={() => { setForm(BLANK); setShowForm(s => !s) }}
        >
          {showForm ? '✕ Cancel' : '+ New Waypoint'}
        </button>
        {waypoints.length > 0 && (
          <button className={css.exportBtn} onClick={exportGpx} title="Export all as GPX">
            GPX ↓
          </button>
        )}
        <button className={css.exportBtn} onClick={() => fileInputRef.current?.click()} title="Import waypoints from GPX">
          GPX ↑
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".gpx"
          style={{ display: 'none' }}
          onChange={importGpx}
        />
      </div>

      {/* New waypoint form */}
      {showForm && (
        <div className={css.form}>
          <div className={css.formRow}>
            <label htmlFor={`${formId}-name`} className={css.formLabel}>Name</label>
            <input
              id={`${formId}-name`}
              className={css.input}
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Waypoint name"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') submit() }}
            />
          </div>
          <div className={css.formRow}>
            <label className={css.formLabel}>Lat / Lon</label>
            <div className={css.coordRow}>
              <input
                className={`${css.inputSmall} ${form.lat && !latValid ? css.inputError : ''}`}
                value={form.lat}
                onChange={e => setForm(f => ({ ...f, lat: e.target.value }))}
                placeholder="59.3293"
                inputMode="decimal"
              />
              <input
                className={`${css.inputSmall} ${form.lng && !lngValid ? css.inputError : ''}`}
                value={form.lng}
                onChange={e => setForm(f => ({ ...f, lng: e.target.value }))}
                placeholder="18.0686"
                inputMode="decimal"
              />
              <button
                className={css.pickBtn}
                onClick={onStartPlace}
                title="Click on map to pick coordinates"
                aria-label="Pick on map"
              >
                📍
              </button>
            </div>
          </div>
          <div className={css.formRow}>
            <label htmlFor={`${formId}-folder`} className={css.formLabel}>Folder</label>
            <input
              id={`${formId}-folder`}
              className={css.input}
              value={form.folder}
              onChange={e => setForm(f => ({ ...f, folder: e.target.value }))}
              placeholder="Unfiled"
              list={`${formId}-folders`}
            />
            {existingFolders.length > 0 && (
              <datalist id={`${formId}-folders`}>
                {existingFolders.map(f => <option key={f} value={f} />)}
              </datalist>
            )}
          </div>
          <div className={css.formActions}>
            <button className={css.saveBtn} onClick={submit} disabled={!canSave}>
              Save Waypoint
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {waypoints.length === 0 && !showForm && (
        <div className={css.empty}>
          No user waypoints yet.<br />
          Use "+ New Waypoint" or right-click the map.
        </div>
      )}

      {/* Folder groups */}
      {folders
        .filter(folder => wpByFolder(folder).length > 0)
        .map(folder => (
          <div key={folder} className={css.folderGroup}>
            <div className={css.folderHeader}>
              <button
                className={`${css.visBtn} ${isFolderVisible(folder) ? css.visBtnOn : ''}`}
                onClick={() => onFolderVisChange(folder, !isFolderVisible(folder))}
                title={`${isFolderVisible(folder) ? 'Hide' : 'Show'} on map`}
                aria-label={`${isFolderVisible(folder) ? 'Hide' : 'Show'} folder on map`}
              >
                {isFolderVisible(folder) ? '●' : '○'}
              </button>
              <span className={css.folderName}>{folder || 'Unfiled'}</span>
              <span className={css.folderCount}>{wpByFolder(folder).length}</span>
            </div>

            <ul className={css.wpList}>
              {wpByFolder(folder).map(wp => (
                <li key={wp.id} className={css.wpRow}>
                  {editingId === wp.id ? (
                    <input
                      className={css.editInput}
                      value={editingName}
                      onChange={e => setEditingName(e.target.value)}
                      title="Edit waypoint name"
                      placeholder="Waypoint name"
                      onBlur={() => {
                        if (editingName.trim() && editingName !== wp.name) {
                          onRename(wp.id, editingName.trim())
                        }
                        setEditingId(null)
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          if (editingName.trim() && editingName !== wp.name) onRename(wp.id, editingName.trim())
                          setEditingId(null)
                        } else if (e.key === 'Escape') {
                          setEditingId(null)
                        }
                      }}
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                    />
                  ) : (
                    <span
                      className={css.wpName}
                      onDoubleClick={() => { setEditingId(wp.id); setEditingName(wp.name) }}
                      title="Double-click to rename"
                    >
                      {wp.name}
                    </span>
                  )}
                  <span className={css.wpCoord}>
                    {wp.lat.toFixed(3)}, {wp.lng.toFixed(3)}
                  </span>
                  <div className={css.wpActions}>
                    <button
                      className={css.wpRouteBtn}
                      onClick={() => onAddToRoute({ lng: wp.lng, lat: wp.lat, name: wp.name })}
                      title="Add to route"
                      aria-label="Add to route"
                    >
                      +
                    </button>
                    <button
                      className={css.wpDeleteBtn}
                      onClick={() => onDelete(wp.id)}
                      title="Delete"
                      aria-label="Delete waypoint"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  )
}
