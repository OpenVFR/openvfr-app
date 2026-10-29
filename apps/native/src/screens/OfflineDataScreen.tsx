/**
 * OfflineDataScreen — download, update and clear the offline map / aviation
 * data. Opened from the "Offline data" row in Settings (moved out of the
 * Settings list because it is long and has its own long-running download).
 */

import React, { useState, useCallback } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { View, Text, ScrollView, TouchableOpacity } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { TILE_BASE } from '../config'
import { refreshTileManifest } from '@open-vfr/shared/tileManifest'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'
import {
  getCacheStatus, getTotalCacheSizeMb, downloadSelected, clearCache,
  REQUIRED_ASSETS, OPTIONAL_ASSETS, defaultOptionalSelection, remoteSizeMb, isCached,
  type DownloadProgress,
} from '../utils/offlineCache'
import { clearProtomapsStyleCache } from '../components/AviationMap'

/** What the Settings row shows: size on disk and whether required data is outdated. */
export function useOfflineSummary(): { value: string; outdated: boolean } {
  const [, setTick] = useState(0)
  useFocusEffect(useCallback(() => {
    // Re-read the cache (the screen may have changed it) and the server manifest.
    setTick(t => t + 1)
    refreshTileManifest(TILE_BASE).then(() => setTick(t => t + 1))
  }, []))
  const statuses = getCacheStatus()
  const requiredKeys = new Set(REQUIRED_ASSETS.map(a => a.key))
  const outdated = statuses.some(x => x.cached && x.stale && requiredKeys.has(x.key))
  const any = statuses.some(x => x.cached)
  return { value: any ? `${getTotalCacheSizeMb()} MB` : 'None', outdated }
}

export function OfflineDataScreen() {
  const styles = useThemedStyles(makeStyles)
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + theme.space5 }]}
    >
      <View style={styles.card}>
        <OfflineDataBody />
      </View>
    </ScrollView>
  )
}

function OfflineDataBody() {
  const styles = useThemedStyles(makeStyles)
  const [statuses, setStatuses] = useState(() => getCacheStatus())
  const [totalMb, setTotalMb]   = useState(() => getTotalCacheSizeMb())
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [confirmDownload, setConfirmDownload] = useState(false)
  // Required (flight-safety-critical) aviation data is always included, no
  // checkbox shown. Optional layers: everything the map needs to look right and
  // the terrain/MSA model is ticked by default (basemap, landuse, terrain, MSA
  // grid, water; ~700 MB, covered by the large-download warning); only the
  // contour lines are an opt-in extra. Already-cached layers start ticked.
  const [selectedOptional, setSelectedOptional] = useState<Set<string>>(() => defaultOptionalSelection())

  const toggleOptional = useCallback((key: string) => {
    setSelectedOptional(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }, [])

  const refresh = useCallback(() => {
    setStatuses(getCacheStatus())
    setTotalMb(getTotalCacheSizeMb())
  }, [])

  // Re-fetch manifest.json on focus (not just app-launch bootstrap) so the
  // stale/outdated badges above reflect the server's CURRENT state, not
  // whatever was current whenever the app process last started -- a pilot
  // could open Settings hours/days into a long-running session.
  useFocusEffect(useCallback(() => {
    refreshTileManifest(TILE_BASE).then(refresh)
  }, [refresh]))

  const allCached = statuses.length > 0 && statuses.every(s => s.cached)
  const anyCached = statuses.some(s => s.cached)
  const requiredKeys = new Set(REQUIRED_ASSETS.map(a => a.key))
  const anyRequiredStale = statuses.some(s => s.cached && s.stale && requiredKeys.has(s.key))
  // Required data is in place but the elevation model is not: offline flight
  // then has no terrain/MSA and AGL limits are unchecked against the ground.
  // That is a safety trade-off worth saying out loud, not a cosmetic one.
  const hillshadeAsset = OPTIONAL_ASSETS.find(a => a.key === 'hillshade')
  const requiredCached = REQUIRED_ASSETS.length > 0 && REQUIRED_ASSETS.every(isCached)
  const terrainMissing = requiredCached && hillshadeAsset != null && !isCached(hillshadeAsset)

  const handleDownload = useCallback(async () => {
    setConfirmDownload(false)
    setDownloading(true)
    setProgress(null)
    const keys = [...REQUIRED_ASSETS.map(a => a.key), ...selectedOptional]
    try {
      await downloadSelected(keys, setProgress)
      clearProtomapsStyleCache()  // pick up freshly cached basemap.pmtiles, if selected
    } finally {
      setDownloading(false)
      setProgress(null)
      refresh()
    }
  }, [refresh, selectedOptional])

  const handleClear = useCallback(() => {
    clearCache()
    clearProtomapsStyleCache()
    refresh()
  }, [refresh])

  return (
    <>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Downloaded for offline use</Text>
        <Text style={styles.infoValue}>{anyCached ? `${totalMb} MB` : 'None'}</Text>
      </View>

      {anyRequiredStale && (
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>⚠️ Offline data outdated</Text>
          <Text style={styles.warningText}>
            Required aviation data has a newer version on the server than what's
            downloaded on this device. Reconnect and "Update offline data" below
            before relying on it in flight.
          </Text>
        </View>
      )}

      {statuses.map(s => (
        <View key={s.key} style={styles.row}>
          <Text style={[styles.rowLabel, { color: theme.textMuted }]}>{s.label}</Text>
          <Text style={[styles.infoValue, s.cached && s.stale ? { color: theme.statusDanger } : undefined]}>
            {s.cached ? `${s.stale ? '⚠️ outdated · ' : '✓ '}${s.sizeMb} MB` : '—'}
          </Text>
        </View>
      ))}

      {terrainMissing && hillshadeAsset && !downloading && (
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>Offline terrain not downloaded</Text>
          <Text style={styles.warningText}>
            {hillshadeAsset.without} Include "{hillshadeAsset.label}" below to
            add it{remoteSizeMb(hillshadeAsset) != null ? ` (about ${remoteSizeMb(hillshadeAsset)} MB)` : ''}.
          </Text>
        </View>
      )}

      <Text style={[styles.rowLabel, { color: theme.textMuted, marginTop: 8 }]}>
        Optional layers to include next download:
      </Text>
      <TouchableOpacity
        style={styles.pressable}
        onPress={() => setSelectedOptional(
          selectedOptional.size >= OPTIONAL_ASSETS.length
            ? new Set()
            : new Set(OPTIONAL_ASSETS.map(a => a.key)),
        )}
        disabled={downloading}
      >
        <Text style={[styles.infoValue, { paddingVertical: 6 }]}>
          {selectedOptional.size >= OPTIONAL_ASSETS.length ? 'Select none' : 'Select all'}
        </Text>
      </TouchableOpacity>
      {OPTIONAL_ASSETS.map(a => {
        const checked = selectedOptional.has(a.key)
        const sizeMb = remoteSizeMb(a)
        return (
          <TouchableOpacity
            key={a.key}
            style={[styles.optionalRow, styles.pressable]}
            onPress={() => toggleOptional(a.key)}
            disabled={downloading}
          >
            <View style={styles.optionalHead}>
              <Text style={styles.rowLabel}>
                {a.label}{sizeMb != null ? ` (${sizeMb} MB)` : ''}
              </Text>
              <Text style={styles.infoValue}>{checked ? '☑ Include' : '☐ Skip'}</Text>
            </View>
            {a.without && (
              <Text style={styles.optionalWithout}>Without it: {a.without}</Text>
            )}
          </TouchableOpacity>
        )
      })}

      {downloading && progress && (
        <View style={styles.warningBox}>
          <Text style={styles.warningText}>
            Downloading {progress.assetLabel} ({progress.assetIndex}/{progress.assetCount})
            {progress.totalBytes > 0
              ? ` — ${Math.round((progress.bytesWritten / progress.totalBytes) * 100)}%`
              : ''}
          </Text>
        </View>
      )}

      {confirmDownload && (
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>⚠️ Large download</Text>
          <Text style={styles.warningText}>
            The basemap alone can be several hundred MB. Use Wi-Fi, not mobile
            data. Existing offline data will be overwritten with the latest version.
          </Text>
          <View style={styles.warningActions}>
            <TouchableOpacity style={styles.warningBtn} onPress={() => setConfirmDownload(false)}>
              <Text style={styles.warningBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.warningBtn, styles.warningBtnPrimary]}
              onPress={handleDownload}
            >
              <Text style={[styles.warningBtnText, styles.warningBtnPrimaryText]}>Download</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {!downloading && (
        <TouchableOpacity
          style={[styles.row, styles.pressable]}
          onPress={() => setConfirmDownload(true)}
        >
          <Text style={styles.rowLabel}>
            {allCached ? 'Update offline data' : 'Download for offline use'}
          </Text>
        </TouchableOpacity>
      )}

      {anyCached && !downloading && (
        <TouchableOpacity style={[styles.row, styles.pressable]} onPress={handleClear}>
          <Text style={[styles.rowLabel, { color: theme.statusDanger }]}>Clear offline data</Text>
        </TouchableOpacity>
      )}
    </>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  container: { flex: 1, backgroundColor: theme.surfaceBase },
  content: { padding: theme.space4, gap: theme.space4 },
  card: {
    backgroundColor: theme.surfacePanel,
    borderRadius:    theme.radiusMd,
    borderWidth:     1,
    borderColor:     theme.borderSubtle,
    overflow:        'hidden' as const,
  },
  row: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'space-between',
    paddingVertical: theme.space3,
    paddingHorizontal: theme.space3,
    minHeight:       44,
  },
  pressable: {
    borderRadius: theme.radiusSm,
  },
  rowLabel: {
    color:    theme.textSecondary,
    fontSize: theme.textXs,
    flex:     1,
  },
  optionalRow: {
    paddingVertical:   theme.space3,
    paddingHorizontal: theme.space3,
    gap:               theme.space1,
  },
  optionalHead: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
  },
  optionalWithout: {
    color:      theme.textMuted,
    fontSize:   theme.textXs,
    lineHeight: 16,
  },
  infoValue: {
    color:    theme.textMuted,
    fontWeight: '400',
    maxWidth:   200,
    textAlign:  'right',
  },
  warningBox: {
    marginHorizontal: theme.space3,
    marginBottom:     theme.space2,
    padding:          theme.space3,
    borderRadius:     theme.radiusSm,
    borderWidth:      1,
    borderColor:      theme.statusWarn,
    backgroundColor:  'rgba(245, 158, 11, 0.08)',
    gap:              theme.space2,
  },
  warningTitle: {
    color:      theme.statusWarn,
    fontSize:   theme.textXs,
    fontWeight: '700',
  },
  warningText: {
    color:    theme.textSecondary,
    fontSize: theme.textXs,
    lineHeight: 16,
  },
  warningActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.space2,
  },
  warningBtn: {
    paddingHorizontal: theme.space3,
    paddingVertical:   theme.space1,
    borderRadius:      theme.radiusSm,
    backgroundColor:   theme.surfaceOverlay,
  },
  warningBtnPrimary: {
    backgroundColor: theme.statusWarn,
  },
  warningBtnText: {
    color:      theme.textSecondary,
    fontSize:   theme.textXs,
    fontWeight: '600',
  },
  warningBtnPrimaryText: {
    color: '#fff',
  },
 } as const
}
