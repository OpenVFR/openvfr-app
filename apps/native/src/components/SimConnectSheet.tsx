/**
 * SimConnectSheet — connectivity panel for simulator and external GPS input.
 *
 * A prominent, dedicated UI rather than a buried settings option.
 *
 * Mode A — UDP auto-detect (primary, zero config):
 *   Tap "Listen on UDP 49002". App waits for X-Plane / MSFS broadcast.
 *   X-Plane: Settings → Network → "Broadcast to ForeFlight/WingX on ALL devices"
 *   MSFS:    Install FS2FF or FSConny (free) — broadcasts automatically.
 *
 * Mode B — WebSocket bridge (fallback):
 *   Run scripts/nmea-ws-bridge.mjs on the sim PC.
 *   Enter PC's LAN IP: ws://192.168.x.x:5104
 */

import React, { useState } from 'react'
import {
  Modal, View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { SimStatus } from '../hooks/useSimInput'
import { theme } from '../styles/theme'

interface Props {
  simStatus:  SimStatus
  onStartUdp: () => void
  onStartWs:  (url: string) => void
  onStop:     () => void
}

export function SimConnectSheet({ simStatus, onStartUdp, onStartWs, onStop }: Props) {
  const [open,   setOpen]   = useState(false)
  const [wsUrl,  setWsUrl]  = useState('ws://192.168.1.')

  const connected = simStatus.mode === 'udp' || simStatus.mode === 'ws'
  const waiting   = simStatus.mode === 'udp'  // bound but no packet yet
  const error     = simStatus.mode === 'error'

  return (
    <>
      {/* Trigger — shows connection status colour */}
      <TouchableOpacity
        style={[styles.trigger, connected && styles.triggerActive, error && styles.triggerError]}
        onPress={() => setOpen(true)}
      >
        <Ionicons
          name="game-controller-outline"
          size={20}
          color={connected ? theme.accentBlue : error ? theme.statusDanger : theme.textSecondary}
        />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)} />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.title}>Simulator / External GPS</Text>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Status banner */}
          {simStatus.mode !== 'off' && (
            <View style={[
              styles.statusBanner,
              simStatus.mode === 'error' && styles.statusError,
              (simStatus.mode === 'udp' || simStatus.mode === 'ws') && styles.statusOk,
            ]}>
              <ActivityIndicator
                size="small"
                color={simStatus.mode === 'error' ? theme.statusDanger : theme.accentBlue}
                animating={simStatus.mode === 'udp' && !simStatus.receiving}
              />
              <Text style={[styles.statusTxt, simStatus.mode === 'error' && styles.statusTxtError]}>
                {simStatus.mode === 'udp' && simStatus.receiving && `Receiving data on UDP ${simStatus.port}`}
                {simStatus.mode === 'udp' && !simStatus.receiving && `Listening on UDP ${simStatus.port} — waiting for simulator…`}
                {simStatus.mode === 'ws'    && `Connected: ${simStatus.url}`}
                {simStatus.mode === 'error' && simStatus.message}
              </Text>
              <TouchableOpacity onPress={onStop}>
                <Text style={styles.disconnectBtn}>Disconnect</Text>
              </TouchableOpacity>
            </View>
          )}

          <View style={styles.body}>
            {/* Mode A — UDP */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="wifi-outline" size={16} color={theme.accentBlue} />
                <Text style={styles.cardTitle}>UDP Auto-detect</Text>
                <View style={styles.badge}><Text style={styles.badgeTxt}>Recommended</Text></View>
              </View>
              <Text style={styles.cardDesc}>
                X-Plane: Settings → Network → "Broadcast to ForeFlight / WingX on ALL devices"{'\n'}
                MSFS: Install FS2FF or FSConny (free) — broadcasts automatically.{'\n'}
                Both send XGPS packets on UDP 49002 to all devices on the LAN.
              </Text>
              <TouchableOpacity
                style={[styles.btn, connected && styles.btnDisabled]}
                onPress={onStartUdp}
                disabled={connected}
              >
                <Text style={styles.btnTxt}>Listen on UDP 49002</Text>
              </TouchableOpacity>
            </View>

            {/* Mode B — WebSocket bridge */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="link-outline" size={16} color={theme.textMuted} />
                <Text style={styles.cardTitle}>WebSocket Bridge</Text>
                <View style={[styles.badge, styles.badgeFallback]}><Text style={styles.badgeTxt}>Fallback</Text></View>
              </View>
              <Text style={styles.cardDesc}>
                Run scripts/nmea-ws-bridge.mjs on your sim PC.{'\n'}
                Enter the PC's LAN IP below. Supports XGPS and NMEA sentences.
              </Text>
              <TextInput
                style={styles.input}
                value={wsUrl}
                onChangeText={setWsUrl}
                placeholder="ws://192.168.1.x:5104"
                placeholderTextColor={theme.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <TouchableOpacity
                style={[styles.btn, styles.btnSecondary, connected && styles.btnDisabled]}
                onPress={() => onStartWs(wsUrl.trim())}
                disabled={connected || !wsUrl.trim().startsWith('ws')}
              >
                <Text style={[styles.btnTxt, styles.btnTxtSecondary]}>Connect via WebSocket</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.note}>
              Once connected the app uses the simulator's position instead of device GPS.
              Tap "Disconnect" in the status banner or reopen this panel to stop.
            </Text>
          </View>
        </View>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  trigger: {
    width:           40,
    height:          40,
    borderRadius:    theme.radiusMd,
    backgroundColor: 'rgba(19,24,36,0.90)',
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    alignItems:      'center',
    justifyContent:  'center',
  },
  triggerActive: { borderColor: theme.accentBlue },
  triggerError:  { borderColor: theme.statusDanger },
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    backgroundColor:    theme.surfacePanel,
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    borderTopWidth:     1,
    borderColor:        theme.borderDefault,
    maxHeight:          '85%',
  },
  handle: {
    width:           40,
    height:          4,
    borderRadius:    2,
    backgroundColor: theme.borderDefault,
    alignSelf:       'center',
    marginTop:       10,
    marginBottom:    4,
  },
  header: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: theme.space4,
    paddingVertical:   theme.space2,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  title: {
    color:      theme.textPrimary,
    fontSize:   theme.textMd,
    fontWeight: '700',
  },
  statusBanner: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               theme.space2,
    paddingHorizontal: theme.space4,
    paddingVertical:   theme.space2,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
    backgroundColor:   'rgba(59,130,246,0.08)',
  },
  statusOk:    { backgroundColor: 'rgba(59,130,246,0.08)' },
  statusError: { backgroundColor: 'rgba(239,68,68,0.08)' },
  statusTxt: {
    flex:     1,
    color:    theme.accentBlue,
    fontSize: theme.textXs,
  },
  statusTxtError: { color: theme.statusDanger },
  disconnectBtn: {
    color:      theme.statusDanger,
    fontSize:   theme.textXs,
    fontWeight: '600',
  },
  body: {
    padding: theme.space4,
    gap:     theme.space3,
  },
  card: {
    backgroundColor: theme.surfaceOverlay,
    borderRadius:    theme.radiusMd,
    borderWidth:     1,
    borderColor:     theme.borderSubtle,
    padding:         theme.space3,
    gap:             theme.space2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           theme.space2,
  },
  cardTitle: {
    flex:       1,
    color:      theme.textPrimary,
    fontSize:   theme.textSm,
    fontWeight: '600',
  },
  badge: {
    backgroundColor: 'rgba(59,130,246,0.15)',
    borderRadius:    10,
    paddingHorizontal: 6,
    paddingVertical:   2,
  },
  badgeFallback: { backgroundColor: 'rgba(100,100,100,0.15)' },
  badgeTxt: {
    color:      theme.accentBlue,
    fontSize:   9,
    fontWeight: '700',
  },
  cardDesc: {
    color:      theme.textMuted,
    fontSize:   theme.textXs,
    lineHeight: 16,
  },
  input: {
    backgroundColor:   theme.surfaceBase,
    borderWidth:       1,
    borderColor:       theme.borderDefault,
    borderRadius:      theme.radiusSm,
    paddingHorizontal: theme.space3,
    paddingVertical:   theme.space2,
    color:             theme.textPrimary,
    fontSize:          theme.textSm,
  },
  btn: {
    backgroundColor: theme.accentBlue,
    borderRadius:    theme.radiusSm,
    paddingVertical: theme.space2,
    alignItems:      'center',
  },
  btnSecondary: {
    backgroundColor: 'transparent',
    borderWidth:     1,
    borderColor:     theme.borderDefault,
  },
  btnDisabled: { opacity: 0.4 },
  btnTxt: {
    color:      '#fff',
    fontSize:   theme.textSm,
    fontWeight: '600',
  },
  btnTxtSecondary: { color: theme.textSecondary },
  note: {
    color:     theme.textFaint,
    fontSize:  theme.textXs,
    textAlign: 'center',
    lineHeight: 16,
  },
})
