/**
 * SettingsScreen — app preferences.
 */

import React, { useState, useCallback, useEffect } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import {
  View, Text, Switch, ScrollView, TextInput,
  TouchableOpacity, Alert,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useSettingsContext } from '../context/SettingsContext'
import { useAuthContext }     from '../context/AuthContext'
import { useSimContext }      from '../context/SimContext'
import { SimConnectSheet }    from '../components/SimConnectSheet'
import { useInternalBarometer } from '../hooks/useInternalBarometer'
import { useVarioContext } from '../context/VarioContext'
import type { VarioState } from '@open-vfr/shared/blueflyVario'
import { useNearestQnh } from '../hooks/useNearestQnh'
import { useAerodromeElevation } from '../hooks/useAerodromeElevation'
import { useNearestAerodrome } from '../hooks/useNearestAerodrome'
import { qnhFromStationPressure } from '@open-vfr/shared/baroAltitude'
import * as Location from 'expo-location'
import { API_BASE, TILE_BASE } from '../config'
import { refreshTileManifest } from '@open-vfr/shared/tileManifest'
import { theme, useThemedStyles, useScaledTheme, type ScaledTheme } from '../styles/theme'
import {
  getCacheStatus, getTotalCacheSizeMb, downloadSelected, clearCache,
  REQUIRED_ASSETS, OPTIONAL_ASSETS,
  type DownloadProgress,
} from '../utils/offlineCache'
import { clearProtomapsStyleCache } from '../components/AviationMap'

const UI_SCALE_OPTIONS = [0.85, 0.9, 1.0, 1.1, 1.2, 1.3, 1.45, 1.6]

export function SettingsScreen() {
  const scaledTheme          = useScaledTheme()
  const styles                = useThemedStyles(makeStyles)
  const insets               = useSafeAreaInsets()
  const { settings, update } = useSettingsContext()
  const { state, signOut, registerPasskey, requestAccountDeletion } = useAuthContext()
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteSent, setDeleteSent] = useState(false)

  const handleDeleteAccount = useCallback(() => {
    Alert.alert(
      'Delete account?',
      "This permanently deletes your account and all associated data (routes, aircraft profiles, waypoints, settings, flight logs). We'll email a confirmation link \u2014 nothing is deleted until you click it.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send deletion email',
          style: 'destructive',
          onPress: () => {
            setDeleteBusy(true)
            requestAccountDeletion()
              .then((ok: boolean) => { if (ok) setDeleteSent(true) })
              .finally(() => setDeleteBusy(false))
          },
        },
      ],
    )
  }, [requestAccountDeletion])
  const { simStatus, simPosition, startUdp, startWs, stopSim } = useSimContext()
  const internalBaro = useInternalBarometer(settings.useInternalBarometer)
  const vario = useVarioContext()
  const [showBaroWarning, setShowBaroWarning] = useState(false)
  const [showBleScan, setShowBleScan] = useState(false)
  const hasBarometricSource =
    (settings.useInternalBarometer && internalBaro.availability === 'available') ||
    vario.status === 'connected'

  // QNH self-calibration target — any aerodrome with a known elevation, not
  // just the home-airfield setting. Defaults to whichever aerodrome is
  // currently closest (via GPS), since that's almost certainly where the
  // pilot is actually parked; editable in case that guess is wrong or GPS
  // isn't available (e.g. indoors), or the pilot is testing from a
  // different field's known elevation entirely.
  const [calibrateIcao, setCalibrateIcao] = useState('')
  const [calibrateIcaoTouched, setCalibrateIcaoTouched] = useState(false)

  // One-shot last-known position (not a continuous watch — avoids a second
  // GPS subscription instance alongside MapScreen's) purely to show the
  // *actual* live auto-derived QNH here, refreshed each time Settings is
  // opened — same "re-fetch on focus" pattern as the AIRAC cycle check below.
  const [settingsPos, setSettingsPos] = useState<{ lat: number; lng: number } | null>(null)
  useFocusEffect(useCallback(() => {
    // Always fetch — used both for auto-QNH (when enabled) and to suggest
    // the nearest aerodrome for QNH self-calibration below.
    Location.getLastKnownPositionAsync().then((loc) => {
      if (loc) setSettingsPos({ lat: loc.coords.latitude, lng: loc.coords.longitude })
    }).catch(() => {})
  }, []))
  // Prefer a live simulator fix over the device's real GPS — otherwise, while
  // simulating a flight elsewhere (e.g. X-Plane over Sweden), this screen
  // keeps suggesting the nearest ICAO/METAR to the *device's* real location
  // instead of the simulated one.
  const activeSettingsPos = simPosition ?? settingsPos
  // Memoized on primitives, not rebuilt as a new object every render: an
  // unmemoized `{ ...activeSettingsPos, altFt: 0, ... }` literal here fed
  // useNearestQnh/useNearestAerodrome's effect dependency arrays, which
  // fired on every render and unconditionally set new result objects,
  // feeding back into another render — the same 'Maximum update depth
  // exceeded' infinite loop fixed in MapScreen.tsx's positionForAlerts.
  const qnhPos = React.useMemo(
    () => activeSettingsPos ? { ...activeSettingsPos, altFt: 0, speedKts: 0, trackDeg: 0, accuracy: 0 } : null,
    [activeSettingsPos?.lat, activeSettingsPos?.lng],
  )
  const liveAutoQnh = useNearestQnh(qnhPos, settings.qnhAuto)
  const nearestAerodrome = useNearestAerodrome(qnhPos)
  useEffect(() => {
    if (!calibrateIcaoTouched && nearestAerodrome && calibrateIcao !== nearestAerodrome.icao) {
      setCalibrateIcao(nearestAerodrome.icao)
    }
  }, [calibrateIcaoTouched, nearestAerodrome, calibrateIcao])
  const calibrateElevationFt = useAerodromeElevation(calibrateIcao)

  // Fetch AIRAC cycle from manifest.json — re-fetch each time Settings tab is opened
  const [dataAirac, setDataAirac] = useState<string | null>(null)
  useFocusEffect(useCallback(() => {
    fetch(`${TILE_BASE}/tiles/manifest.json`)
      .then(r => r.ok ? r.json() : null)
      .then((m: { airac_cycle?: string; countries?: Record<string, Record<string, { airac_cycle?: string }>> } | null) => {
        if (!m) return
        // Top-level airac_cycle (local dev manifest)
        if (m.airac_cycle) { setDataAirac(m.airac_cycle); return }
        // Per-dataset airac_cycle (server manifest: countries.se.airspace.airac_cycle)
        const countries = m.countries ?? {}
        for (const datasets of Object.values(countries)) {
          for (const ds of Object.values(datasets)) {
            if (ds?.airac_cycle) { setDataAirac(ds.airac_cycle); return }
          }
        }
      })
      .catch(() => {})
  }, []))

  // AIRAC cycle logic — epoch 2501 = 2025-01-02
  const AIRAC_EPOCH_MS = Date.UTC(2025, 0, 2)
  const AIRAC_DAYS     = 28
  const expectedAirac  = (() => {
    const elapsed    = Math.max(0, Date.now() - AIRAC_EPOCH_MS)
    const cycleIndex = Math.floor(elapsed / (AIRAC_DAYS * 86_400_000))
    const total      = cycleIndex
    const year       = 2025 + Math.floor(total / 13)
    const inYear     = (total % 13) + 1
    return `${String(year).slice(-2)}${String(inYear).padStart(2, '0')}`
  })()
  const airacStale = dataAirac !== null && dataAirac !== expectedAirac

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + scaledTheme.space4 }]}
    >
      <Text style={styles.screenTitle}>Settings</Text>

      {/* ── Units ─────────────────────────────────────────────────── */}
      <Section title="Units">
        <RowToggle
          label="Distance"
          left="NM"
          right="km"
          value={settings.units.distance === 'km'}
          onToggle={v => update({ units: { ...settings.units, distance: v ? 'km' : 'nm' } })}
        />
        <RowToggle
          label="Speed"
          left="kts"
          right="km/h"
          value={settings.units.speed === 'kmh'}
          onToggle={v => update({ units: { ...settings.units, speed: v ? 'kmh' : 'kts' } })}
        />
      </Section>

      {/* ── Display ───────────────────────────────────────────────── */}
      <Section title="Display">
        <RowStep
          label="UI scale"
          value={settings.uiScale}
          options={UI_SCALE_OPTIONS}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => update({ uiScale: v })}
        />
      </Section>

      {/* ── Home airfield ─────────────────────────────────────────── */}
      <Section title="Home Airfield">
        <View style={styles.row}>
          <Text style={styles.rowLabel}>ICAO code</Text>
          <TextInput
            style={styles.textInput}
            value={settings.homeAirfield}
            onChangeText={v => update({ homeAirfield: v.toUpperCase() })}
            placeholder="e.g. ESSA"
            placeholderTextColor={theme.textFaint}
            autoCapitalize="characters"
            maxLength={4}
          />
        </View>
      </Section>

      {/* ── Navigation ────────────────────────────────────────────── */}
            {/* ── Airspace Warnings ─────────────────────────────── */}
      <Section title="Airspace Warnings">
        <RowStep
          label="Horizontal lookahead"
          value={settings.airspaceWarnLookaheadMin}
          options={[1, 2, 3, 5, 8, 10]}
          format={(v) => `${v} min`}
          onChange={(v) => update({ airspaceWarnLookaheadMin: v })}
        />
        <RowStep
          label="Vertical buffer"
          value={settings.airspaceWarnVerticalFt}
          options={[0, 100, 200, 300, 500, 750, 1000, 1500]}
          format={(v) => v === 0 ? 'Off' : `${v} ft`}
          onChange={(v) => update({ airspaceWarnVerticalFt: v })}
        />
      </Section>

      <Section title="Navigation">
        <RowStep
          label="Trajectory lookahead"
          value={settings.trajectoryNm}
          options={[2, 3, 5, 8, 10, 15, 20]}
          format={(v) => `${v} ${(settings.trajectoryMode ?? 'time') === 'time' ? 'min' : 'NM'}`}
          onChange={(v) => update({ trajectoryNm: v })}
        />
        <RowToggle
          label="Trajectory mode"
          left="Time"
          right="NM"
          value={(settings.trajectoryMode ?? 'time') === 'nm'}
          onToggle={(v) => update({ trajectoryMode: v ? 'nm' : 'time' })}
        />
      </Section>

      {/* ── Vario / Barometric Altitude ──────────────────────────── */}
      <Section title="Vario">
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Internal barometer</Text>
          {internalBaro.availability === 'unavailable' ? (
            <Text style={styles.infoValue}>Not available on this device</Text>
          ) : (
            <Switch
              value={settings.useInternalBarometer}
              disabled={internalBaro.availability === 'checking'}
              onValueChange={(v) => {
                if (v) { setShowBaroWarning(true) } else { update({ useInternalBarometer: false }) }
              }}
            />
          )}
        </View>

        {showBaroWarning && (
          <View style={styles.warningBox}>
            <Text style={styles.warningTitle}>⚠️ Flight Safety Warning</Text>
            <Text style={styles.warningText}>
              Your phone's internal barometer measures pocket/cabin pressure, not true
              outside static pressure, and can be inaccurate depending on how the device is
              mounted or carried. Only enable this if you understand the limitation.
              A connected BlueFly Vario (external, vented sensor) is always preferred over
              this when available.
            </Text>
            <View style={styles.warningActions}>
              <TouchableOpacity style={styles.warningBtn} onPress={() => setShowBaroWarning(false)}>
                <Text style={styles.warningBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.warningBtn, styles.warningBtnPrimary]}
                onPress={() => { update({ useInternalBarometer: true }); setShowBaroWarning(false) }}
              >
                <Text style={[styles.warningBtnText, styles.warningBtnPrimaryText]}>Enable</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.row}>
          <Text style={styles.rowLabel}>BlueFly Vario (BLE)</Text>
          <Text style={styles.infoValue}>{varioStatusLabel(vario.status)}</Text>
        </View>

        {vario.status === 'connected' && vario.state && (
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Device</Text>
            <Text
              style={[
                styles.infoValue,
                styles.deviceStatusValue,
                vario.state.batteryPercent < 20 && { color: theme.statusDanger },
              ]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {formatVarioDeviceStatus(vario.state)}
            </Text>
          </View>
        )}

        {vario.status === 'connected' ? (
          <TouchableOpacity style={[styles.row, styles.pressable]} onPress={vario.disconnect}>
            <Text style={[styles.rowLabel, { color: theme.statusDanger }]}>Disconnect</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.row, styles.pressable]}
            onPress={() => {
              setShowBleScan(true)
              vario.scan()
            }}
          >
            <Text style={styles.rowLabel}>Scan for BlueFly Vario…</Text>
          </TouchableOpacity>
        )}

        {settings.varioAutoConnectId !== '' && (
          <TouchableOpacity style={[styles.row, styles.pressable]} onPress={vario.forget}>
            <Text style={[styles.rowLabel, { color: theme.textMuted }]}>Forget remembered device</Text>
          </TouchableOpacity>
        )}

        {showBleScan && vario.status !== 'connected' && (
          <View style={styles.bleScanBox}>
            {vario.status === 'scanning' && vario.found.length === 0 && (
              <Text style={styles.warningText}>Scanning…</Text>
            )}
            {vario.found.map(d => (
              <TouchableOpacity
                key={d.id}
                style={styles.bleDeviceRow}
                onPress={() => { vario.connect(d.id); setShowBleScan(false) }}
              >
                <Text style={styles.rowLabel}>{d.name ?? d.id}</Text>
                <Text style={styles.infoValue}>{d.rssi != null ? `${d.rssi} dBm` : ''}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={() => { vario.stopScan(); setShowBleScan(false) }}>
              <Text style={[styles.warningBtnText, { textAlign: 'center', marginTop: scaledTheme.space1 }]}>Close</Text>
            </TouchableOpacity>
          </View>
        )}

        {hasBarometricSource ? (
          <>
            <RowToggle
              label="QNH source"
              left="Auto"
              right="Manual"
              value={!settings.qnhAuto}
              onToggle={(v) => update({ qnhAuto: !v })}
            />
            <RowStep
              label="QNH"
              value={settings.qnhAuto ? Math.round(liveAutoQnh.qnhHpa ?? settings.qnhHpa) : settings.qnhHpa}
              options={QNH_OPTIONS}
              format={(v) => settings.qnhAuto
                ? (liveAutoQnh.stations.length > 0
                  ? `${v} hPa (auto, ${liveAutoQnh.stations.length} stn${liveAutoQnh.stations.length > 1 ? 's' : ''}: ${liveAutoQnh.stations.slice(0, 3).join('/')})`
                  : `${v} hPa (auto — no METAR signal, using ISA default)`)
                : `${v} hPa (manual)`}
              onChange={(v) => update({ qnhHpa: v })}
              disabled={settings.qnhAuto}
            />
            {vario.status === 'connected' && vario.state && (
              <>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Calibrate at ICAO</Text>
                  <TextInput
                    style={[styles.textInput, { textAlign: 'right' }]}
                    value={calibrateIcao}
                    onChangeText={(v) => { setCalibrateIcaoTouched(true); setCalibrateIcao(v.toUpperCase()) }}
                    placeholder={nearestAerodrome?.icao ?? 'ICAO'}
                    autoCapitalize="characters"
                    maxLength={4}
                  />
                </View>
                {nearestAerodrome && (
                  <View style={styles.row}>
                    <Text style={[styles.infoValue, { maxWidth: undefined, textAlign: 'left' }]}>
                      Nearest: {nearestAerodrome.icao} ({nearestAerodrome.distanceNm.toFixed(1)} nm away)
                    </Text>
                  </View>
                )}
                {calibrateElevationFt != null && (
                  <TouchableOpacity
                    style={[styles.row, styles.pressable]}
                    onPress={() => {
                      const elevationM = calibrateElevationFt / 3.28084
                      const qnh = qnhFromStationPressure(vario.state!.pressurePa, elevationM)
                      update({ qnhAuto: false, qnhHpa: Math.round(qnh) })
                    }}
                  >
                    <Text style={styles.rowLabel}>
                      Calibrate QNH from {calibrateIcao} field elevation ({calibrateElevationFt} ft) — only valid when parked there
                    </Text>
                    <Text style={styles.infoValue}>
                      {Math.round(qnhFromStationPressure(vario.state.pressurePa, calibrateElevationFt / 3.28084))} hPa
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </>
        ) : (
          <View style={styles.row}>
            <Text style={[styles.infoValue, { maxWidth: undefined, textAlign: 'left' }]}>
              QNH settings appear once an internal barometer or BlueFly Vario is enabled/connected
            </Text>
          </View>
        )}
      </Section>

      {/* ── Simulator ───────────────────────────────── */}
      <Section title="Simulator">
        <View style={styles.row}>
          <Text style={styles.rowLabel}>X-Plane / MSFS</Text>
          <SimConnectSheet
            simStatus={simStatus}
            onStartUdp={startUdp}
            onStartWs={startWs}
            onStop={stopSim}
          />
        </View>
      </Section>

      <Section title="Offline Data">
        <OfflineDataSection />
      </Section>

      <Section title="About">
        <InfoRow label="Version"        value="0.1.0" />
        <InfoRow label="Server"         value={API_BASE} />
        <InfoRow label="Aviation data"  value={dataAirac ? `OFM AIRAC ${dataAirac}${airacStale ? ' ⚠️ outdated' : ''}` : 'OFM (loading…)'} />
        <InfoRow label="Obstacles"      value="OpenAIP (CC BY-NC 4.0)" />
        <InfoRow label="Basemap"        value="Protomaps / OSM (ODbL)" />
        {state.status === 'authenticated' && (
          <InfoRow label="Signed in as" value={state.user.email} />
        )}
      </Section>

      {/* ── Account ───────────────────────────────────────────── */}
      {state.status === 'authenticated' && (
        <Section title="Account">
          <TouchableOpacity style={[styles.row, styles.pressable]} onPress={registerPasskey}>
            <Text style={styles.rowLabel}>Register passkey on this device</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.row, styles.pressable]} onPress={signOut}>
            <Text style={[styles.rowLabel, { color: theme.statusDanger }]}>Sign out</Text>
          </TouchableOpacity>
          {deleteSent ? (
            <View style={styles.row}>
              <Text style={[styles.rowLabel, { color: theme.textMuted, flex: 1 }]}>
                Check {state.user.email} for a link to confirm deletion. Expires in 24 hours.
              </Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.row, styles.pressable]}
              onPress={handleDeleteAccount}
              disabled={deleteBusy}
            >
              <Text style={[styles.rowLabel, { color: theme.statusDanger }]}>
                {deleteBusy ? 'Sending\u2026' : 'Delete account and all data'}
              </Text>
            </TouchableOpacity>
          )}
        </Section>
      )}
    </ScrollView>
  )
}

// QNH stepper range, 1 hPa steps, covers extreme-low to extreme-high real-world settings.
const QNH_OPTIONS: number[] = Array.from({ length: 101 }, (_, i) => 950 + i)

function varioStatusLabel(status: string): string {
  switch (status) {
    case 'connected':    return 'Connected'
    case 'connecting':   return 'Connecting\u2026'
    case 'scanning':     return 'Scanning\u2026'
    case 'disconnected': return 'Disconnected'
    case 'error':        return 'Connection error'
    case 'permission-denied': return 'Bluetooth permission denied'
    default:             return 'Not connected'
  }
}

function formatVarioDeviceStatus(state: VarioState): string {
  const parts = [`\u{1f50b}${Math.round(state.batteryPercent)}%`]
  if (state.batteryVolts != null) parts.push(`${state.batteryVolts.toFixed(1)}V`)
  parts.push(`${Math.round(state.temperatureC)}\u00b0C`)
  parts.push(`${(state.pressurePa / 100).toFixed(1)}hPa`)
  return parts.join('  ')
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const sectionStyles = useThemedStyles(makeSectionStyles)
  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.title}>{title.toUpperCase()}</Text>
      <View style={sectionStyles.card}>{children}</View>
    </View>
  )
}

function RowToggle({
  label, left, right, value, onToggle,
}: { label: string; left: string; right: string; value: boolean; onToggle: (v: boolean) => void }) {
  const styles = useThemedStyles(makeStyles)
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.segmented}>
        <TouchableOpacity
          style={[styles.seg, !value && styles.segActive]}
          onPress={() => onToggle(false)}
        >
          <Text style={[styles.segText, !value && styles.segTextActive]}>{left}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.seg, value && styles.segActive]}
          onPress={() => onToggle(true)}
        >
          <Text style={[styles.segText, value && styles.segTextActive]}>{right}</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

function RowStep<T extends number>({
  label, value, options, format, onChange, disabled,
}: {
  label: string
  value: T
  options: T[]
  format: (v: T) => string
  onChange: (v: T) => void
  disabled?: boolean
}) {
  const styles     = useThemedStyles(makeStyles)
  const stepStyles = useThemedStyles(makeStepStyles)
  // Find the nearest option rather than assuming `value` is exactly present
  // in `options` (e.g. qnhHpa's non-integer 1013.25 default isn't in the
  // integer 950–1050 QNH_OPTIONS list) — indexOf(-1) previously made the
  // "prev" button jump straight to options[0] (950) on first tap.
  const idx = options.reduce(
    (best, opt, i) => Math.abs(opt - value) < Math.abs(options[best] - value) ? i : best,
    0,
  )
  const prev = () => onChange(options[Math.max(0, idx - 1)])
  const next = () => onChange(options[Math.min(options.length - 1, idx + 1)])
  return (
    <View style={[styles.row, disabled && stepStyles.rowDisabled]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={stepStyles.control}>
        <TouchableOpacity
          style={[stepStyles.btn, (idx === 0 || disabled) && stepStyles.btnDisabled]}
          onPress={prev} disabled={idx === 0 || disabled}
        >
          <Text style={stepStyles.arrow}>{'<'}</Text>
        </TouchableOpacity>
        <Text style={stepStyles.value}>{format(value)}</Text>
        <TouchableOpacity
          style={[stepStyles.btn, (idx === options.length - 1 || disabled) && stepStyles.btnDisabled]}
          onPress={next} disabled={idx === options.length - 1 || disabled}
        >
          <Text style={stepStyles.arrow}>{'>'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

function makeStepStyles(theme: ScaledTheme) {
  return {
    rowDisabled: { opacity: 0.5 },
    control: {
      flexDirection: 'row' as const,
      alignItems:    'center' as const,
      gap:           theme.space1,
      borderWidth:   1,
      borderColor:   theme.borderDefault,
      borderRadius:  theme.radiusSm,
      overflow:      'hidden' as const,
    },
    btn: {
      paddingHorizontal: theme.space2,
      paddingVertical:   theme.space1,
      backgroundColor:   theme.surfaceOverlay,
    },
    btnDisabled: { opacity: 0.35 },
    arrow: {
      color:      theme.textSecondary,
      fontWeight: '700' as const,
      fontSize:   theme.textSm,
    },
    value: {
      color:      theme.textPrimary,
      fontSize:   theme.textXs,
      fontWeight: '600' as const,
      minWidth:   52,
      textAlign:  'center' as const,
    },
  }
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(makeStyles)
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, styles.infoValue]} numberOfLines={1}>{value}</Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Offline Data
// ---------------------------------------------------------------------------
function OfflineDataSection() {
  const styles = useThemedStyles(makeStyles)
  const [statuses, setStatuses] = useState(() => getCacheStatus())
  const [totalMb, setTotalMb]   = useState(() => getTotalCacheSizeMb())
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [confirmDownload, setConfirmDownload] = useState(false)
  // Optional/cosmetic layers (basemap, landuse, hillshade) are opt-in per
  // asset — default unchecked so a first download doesn't silently pull
  // hundreds of MB the pilot didn't ask for. Required (flight-safety-
  // critical) aviation data is always included, no checkbox shown.
  const [selectedOptional, setSelectedOptional] = useState<Set<string>>(() => new Set())

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

      <Text style={[styles.rowLabel, { color: theme.textMuted, marginTop: 8 }]}>
        Optional layers to include next download:
      </Text>
      {OPTIONAL_ASSETS.map(a => {
        const checked = selectedOptional.has(a.key)
        return (
          <TouchableOpacity
            key={a.key}
            style={[styles.row, styles.pressable]}
            onPress={() => toggleOptional(a.key)}
            disabled={downloading}
          >
            <Text style={styles.rowLabel}>{a.label}</Text>
            <Text style={styles.infoValue}>{checked ? '☑ Include' : '☐ Skip'}</Text>
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

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
function makeStyles(theme: ScaledTheme) {
 return {
  container: {
    flex:            1,
    backgroundColor: theme.surfaceBase,
  },
  content: {
    padding:       theme.space4,
    paddingBottom: theme.space5,
    gap:           theme.space4,
  },
  screenTitle: {
    color:      theme.textPrimary,
    fontSize:   theme.text2xl,
    fontWeight: '700',
    marginBottom: theme.space2,
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
    fontSize: theme.textSm,
    flex:     1,
  },
  rowValue: {
    color:    theme.textPrimary,
    fontSize: theme.textSm,
    fontWeight: '500',
  },
  infoValue: {
    color:    theme.textMuted,
    fontWeight: '400',
    maxWidth:   200,
    textAlign:  'right',
  },
  deviceStatusValue: {
    fontSize: theme.textXs,
    maxWidth: 230,
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
    fontSize:   theme.textSm,
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
  bleScanBox: {
    marginHorizontal: theme.space3,
    marginBottom:     theme.space2,
    padding:          theme.space2,
    borderRadius:     theme.radiusSm,
    borderWidth:      1,
    borderColor:      theme.borderDefault,
    backgroundColor:  theme.surfaceOverlay,
    gap:              theme.space1,
  },
  bleDeviceRow: {
    flexDirection:   'row',
    justifyContent:  'space-between',
    alignItems:      'center',
    paddingVertical: theme.space1,
    paddingHorizontal: theme.space1,
  },
  checkmark: {
    color:    theme.accentGreen,
    fontSize: theme.textMd,
  },
  textInput: {
    color:           theme.textPrimary,
    fontSize:        theme.textSm,
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    borderRadius:    theme.radiusSm,
    paddingHorizontal: theme.space2,
    paddingVertical: theme.space1,
    minWidth:        80,
    textAlign:       'center',
    backgroundColor: theme.surfaceOverlay,
  },
  segmented: {
    flexDirection: 'row',
    borderWidth:   1,
    borderColor:   theme.borderDefault,
    borderRadius:  theme.radiusSm,
    overflow:      'hidden',
  },
  seg: {
    paddingHorizontal: theme.space2,
    paddingVertical:   theme.space1,
    backgroundColor:   theme.surfacePanel,
  },
  segActive: {
    backgroundColor: theme.accentBlue,
  },
  segText: {
    color:    theme.textMuted,
    fontSize: theme.textXs,
    fontWeight: '600',
  },
  segTextActive: {
    color: '#fff',
  },
 } as const
}

function makeSectionStyles(theme: ScaledTheme) {
 return {
  container: {
    gap: theme.space1,
  },
  title: {
    color:     theme.textFaint,
    fontSize:  theme.textXs,
    fontWeight: '600' as const,
    letterSpacing: 0.8,
    paddingHorizontal: theme.space1,
    marginBottom: theme.space1,
  },
  card: {
    backgroundColor: theme.surfacePanel,
    borderRadius:    theme.radiusMd,
    borderWidth:     1,
    borderColor:     theme.borderSubtle,
    overflow:        'hidden' as const,
  },
 }
}
