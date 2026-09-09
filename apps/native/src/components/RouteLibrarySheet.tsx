/**
 * RouteLibrarySheet — save, load, rename, delete named routes.
 *
 * Integrates with useRouteSync for two-way cloud sync (PostgREST).
 * Local-first: all operations work offline; sync happens in background.
 */

import React, { useState, useEffect, useCallback } from 'react'
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, TextInput,
  FlatList, ActivityIndicator, RefreshControl, Alert,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as Crypto from 'expo-crypto'
import * as FileSystem from 'expo-file-system'
import * as DocumentPicker from 'expo-document-picker'
import * as Sharing from 'expo-sharing'
import { routeToGpx, gpxToRoute } from '@open-vfr/shared/gpx'
import { routes as routeDb } from '../db'
import type { RouteDocType, LegOverride } from '../types/db'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { SyncState } from '../hooks/useRouteSync'
import { theme } from '../styles/theme'
import { distanceNm } from '../utils/routeCalc'

interface Props {
  /** Current active route waypoints */
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  /** aircraft_profile id currently selected — saved with the route */
  aircraftId:   string
  syncState:    SyncState
  onLoad:       (route: RouteDocType) => void
  onPush:       (route: RouteDocType) => void
  onDelete:     (id: string) => void
  /** Pull-to-refresh — re-fetches from cloud (routes added/edited on another
   *  device or the web app while this session is already running), then
   *  reloads the local list. Optional — sheet still works standalone/offline
   *  without it. */
  onRefreshCloud?: () => Promise<void>
}

function totalNm(wps: RouteWaypoint[]): number {
  return wps.slice(0, -1).reduce((s, wp, i) => s + distanceNm(wp, wps[i + 1]), 0)
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]} ${d.getFullYear()}`
}

export function RouteLibrarySheet({ waypoints, legOverrides, aircraftId, syncState, onLoad, onPush, onDelete, onRefreshCloud }: Props) {
  const [open,     setOpen]     = useState(false)
  const [routes,   setRoutes]   = useState<RouteDocType[]>([])
  const [saving,   setSaving]   = useState(false)
  const [saveName, setSaveName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)  // route id
  const [renameTxt, setRenameTxt] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = useCallback(async () => {
    if (!onRefreshCloud) return
    setRefreshing(true)
    try { await onRefreshCloud() } finally { setRefreshing(false) }
  }, [onRefreshCloud])

  const loadRoutes = useCallback(() => {
    routeDb.getAll()
      .then(all => setRoutes(all.filter(r => r.id !== 'current').sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (open) loadRoutes()
  }, [open, loadRoutes])

  // Pull fresh data from the cloud the moment the sheet opens — don't make
  // the user discover the pull-to-refresh gesture to see a route saved
  // elsewhere (web app or another device) since this session started.
  useEffect(() => {
    if (open) void onRefreshCloud?.()
  }, [open, onRefreshCloud])

  // Reload when sync finishes
  useEffect(() => {
    if (syncState === 'idle' && open) loadRoutes()
  }, [syncState, open, loadRoutes])

  const handleSave = async () => {
    const name = saveName.trim() || `Route ${new Date().toLocaleDateString()}`
    const doc: RouteDocType = {
      id:           Crypto.randomUUID(),
      name,
      waypoints:    waypoints,
      legOverrides: legOverrides,
      aircraftId,
      updatedAt:    Date.now(),
    }
    await routeDb.upsert(doc)
    onPush(doc)
    setSaveName('')
    setSaving(false)
    loadRoutes()
  }

  const handleLoad = (route: RouteDocType) => {
    onLoad(route)
    setOpen(false)
  }

  const handleRename = async (id: string) => {
    const name = renameTxt.trim()
    if (!name) return
    const route = routes.find(r => r.id === id)
    if (!route) return
    const updated = { ...route, name, updatedAt: Date.now() }
    await routeDb.upsert(updated)
    onPush(updated)
    setRenaming(null)
    loadRoutes()
  }

  const handleDelete = async (route: RouteDocType) => {
    await routeDb.delete(route.id)
    onDelete(route.id)
    loadRoutes()
  }

  const handleExportGpx = async (route: RouteDocType) => {
    try {
      const xml = routeToGpx(route.waypoints, route.name)
      const file = new FileSystem.File(FileSystem.Paths.cache, `${route.name.replace(/[^\w\- ]/g, '_')}.gpx`)
      if (file.exists) file.delete()
      file.create()
      file.write(xml)
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: 'application/gpx+xml', dialogTitle: 'Export route as GPX' })
      }
    } catch (e) {
      Alert.alert('Export failed', e instanceof Error ? e.message : String(e))
    }
  }

  const handleImportGpx = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['application/gpx+xml', '*/*'], copyToCacheDirectory: true })
      if (res.canceled || !res.assets?.[0]) return
      const text = await new FileSystem.File(res.assets[0].uri).text()
      const { name, waypoints } = gpxToRoute(text)
      if (waypoints.length === 0) throw new Error('No waypoints found in GPX file')
      const doc: RouteDocType = {
        id: Crypto.randomUUID(),
        name,
        waypoints,
        legOverrides: waypoints.map(() => ({})),
        updatedAt: Date.now(),
      }
      await routeDb.upsert(doc)
      onPush(doc)
      loadRoutes()
    } catch (e) {
      Alert.alert('Import failed', e instanceof Error ? e.message : String(e))
    }
  }

  const syncIcon = syncState === 'syncing' ? (
    <ActivityIndicator size={12} color={theme.accentBlue} />
  ) : syncState === 'error' ? (
    <Ionicons name="cloud-offline-outline" size={14} color={theme.statusDanger} />
  ) : syncState === 'offline' ? (
    <Ionicons name="cloud-offline-outline" size={14} color={theme.textFaint} />
  ) : (
    <Ionicons name="cloud-done-outline" size={14} color={theme.statusOk} />
  )

  return (
    <>
      <TouchableOpacity style={styles.trigger} onPress={() => setOpen(true)}>
        <Ionicons name="folder-outline" size={18} color={theme.textSecondary} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)} />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.title}>Route Library</Text>
            <TouchableOpacity onPress={handleImportGpx} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ marginRight: theme.space2 }}>
              <Ionicons name="download-outline" size={16} color={theme.textSecondary} />
            </TouchableOpacity>
            <View style={styles.syncBadge}>
              {syncIcon}
              <Text style={styles.syncTxt}>
                {syncState === 'syncing' ? 'Syncing…'
                 : syncState === 'error'   ? 'Sync error'
                 : syncState === 'offline' ? 'Offline'
                 : 'Synced'}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Save current route */}
          {waypoints.length >= 2 && (
            <View style={styles.saveSection}>
              {!saving ? (
                <TouchableOpacity style={styles.saveBtn} onPress={() => setSaving(true)}>
                  <Ionicons name="save-outline" size={14} color={theme.accentBlue} />
                  <Text style={styles.saveBtnTxt}>Save current route…</Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.saveRow}>
                  <TextInput
                    style={styles.saveInput}
                    value={saveName}
                    onChangeText={setSaveName}
                    placeholder="Route name"
                    placeholderTextColor={theme.textFaint}
                    autoFocus
                    returnKeyType="done"
                    onSubmitEditing={handleSave}
                  />
                  <TouchableOpacity style={styles.saveConfirm} onPress={handleSave}>
                    <Text style={styles.saveConfirmTxt}>Save</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSaving(false)}>
                    <Ionicons name="close" size={16} color={theme.textMuted} />
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* Route list */}
          {routes.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="map-outline" size={32} color={theme.textFaint} />
              <Text style={styles.emptyTxt}>No saved routes</Text>
              <Text style={styles.emptyHint}>Save the current route to build your library.</Text>
            </View>
          ) : (
            <FlatList
              data={routes}
              keyExtractor={r => r.id}
              renderItem={({ item: route }) => {
                const dist = totalNm(route.waypoints)
                const isRenaming = renaming === route.id
                return (
                  <View style={styles.routeRow}>
                    <TouchableOpacity style={styles.routeInfo} onPress={() => handleLoad(route)}>
                      {isRenaming ? (
                        <View style={styles.renameRow}>
                          <TextInput
                            style={styles.renameInput}
                            value={renameTxt}
                            onChangeText={setRenameTxt}
                            autoFocus
                            returnKeyType="done"
                            onSubmitEditing={() => handleRename(route.id)}
                          />
                          <TouchableOpacity onPress={() => handleRename(route.id)}>
                            <Text style={styles.renameSave}>Save</Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => setRenaming(null)}>
                            <Ionicons name="close" size={14} color={theme.textMuted} />
                          </TouchableOpacity>
                        </View>
                      ) : (
                        <>
                          <Text style={styles.routeName} numberOfLines={1}>{route.name}</Text>
                          <Text style={styles.routeMeta}>
                            {route.waypoints.length} WP · {dist.toFixed(0)} NM · {fmtDate(route.updatedAt)}
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>
                    {!isRenaming && (
                      <View style={styles.routeActions}>
                        <TouchableOpacity style={styles.actionBtn} onPress={() => handleExportGpx(route)}>
                          <Ionicons name="share-outline" size={14} color={theme.textMuted} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.actionBtn}
                          onPress={() => { setRenaming(route.id); setRenameTxt(route.name) }}
                        >
                          <Ionicons name="pencil-outline" size={14} color={theme.textMuted} />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.actionBtn} onPress={() => handleDelete(route)}>
                          <Ionicons name="trash-outline" size={14} color={theme.statusDanger} />
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                )
              }}
              ItemSeparatorComponent={() => <View style={styles.sep} />}
              contentContainerStyle={{ paddingBottom: 24 }}
              refreshControl={onRefreshCloud ? (
                <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={theme.accentBlue} />
              ) : undefined}
            />
          )}
        </View>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  trigger: {
    width:           36,
    height:          36,
    borderRadius:    theme.radiusMd,
    backgroundColor: theme.surfacePanel,
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    alignItems:      'center',
    justifyContent:  'center',
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor:    theme.surfacePanel,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderColor: theme.borderDefault,
    maxHeight: '75%',
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: theme.borderDefault,
    alignSelf: 'center', marginTop: 10, marginBottom: 4,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: theme.space2,
    paddingHorizontal: theme.space4, paddingVertical: theme.space2,
    borderBottomWidth: 1, borderBottomColor: theme.borderSubtle,
  },
  title:     { flex: 1, color: theme.textPrimary, fontSize: theme.textMd, fontWeight: '700' },
  syncBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  syncTxt:   { color: theme.textFaint, fontSize: 10 },
  saveSection: {
    paddingHorizontal: theme.space4, paddingVertical: theme.space2,
    borderBottomWidth: 1, borderBottomColor: theme.borderSubtle,
  },
  saveBtn: { flexDirection: 'row', alignItems: 'center', gap: theme.space1, paddingVertical: 4 },
  saveBtnTxt: { color: theme.accentBlue, fontSize: theme.textSm },
  saveRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space2 },
  saveInput: {
    flex: 1, backgroundColor: theme.surfaceOverlay, borderWidth: 1,
    borderColor: theme.borderDefault, borderRadius: theme.radiusSm,
    paddingHorizontal: theme.space2, paddingVertical: 5,
    color: theme.textPrimary, fontSize: theme.textSm,
  },
  saveConfirm: {
    backgroundColor: theme.accentBlue, borderRadius: theme.radiusSm,
    paddingHorizontal: theme.space2, paddingVertical: 5,
  },
  saveConfirmTxt: { color: '#fff', fontSize: theme.textSm, fontWeight: '600' },
  empty: { padding: theme.space5, alignItems: 'center', gap: theme.space2 },
  emptyTxt:  { color: theme.textSecondary, fontSize: theme.textMd, fontWeight: '500' },
  emptyHint: { color: theme.textFaint, fontSize: theme.textXs, textAlign: 'center' },
  routeRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: theme.space4, paddingVertical: theme.space2,
  },
  routeInfo: { flex: 1 },
  routeName: { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '500' },
  routeMeta: { color: theme.textFaint, fontSize: theme.textXs, marginTop: 1 },
  routeActions: { flexDirection: 'row', gap: theme.space1 },
  actionBtn: { padding: theme.space2 },
  sep: { height: 1, backgroundColor: theme.borderSubtle, marginHorizontal: theme.space4 },
  renameRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space2 },
  renameInput: {
    flex: 1, backgroundColor: theme.surfaceOverlay, borderWidth: 1,
    borderColor: theme.accentBlue, borderRadius: theme.radiusSm,
    paddingHorizontal: theme.space2, paddingVertical: 4,
    color: theme.textPrimary, fontSize: theme.textSm,
  },
  renameSave: { color: theme.accentBlue, fontSize: theme.textXs, fontWeight: '600' },
})
