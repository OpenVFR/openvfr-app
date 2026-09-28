/**
 * FlightModeSheet — replaces the old large "▶ FLY" pill button with a
 * compact 40×40 icon trigger, matching the MapDisplaySheet / FrequencyPanel
 * / SimConnectSheet convention (small icon → bottom sheet), stacked
 * alongside them instead of taking its own dedicated strip of screen space.
 *
 * Offers two ways to get a moving aircraft on the map without real GPS or
 * an external simulator connection:
 *   - "Fly" — real GPS tracking (keep-awake + auto-follow camera)
 *   - "Simulate" — internal touch-controlled flight simulation (SimControlPanel
 *     + useSimFlight), for testing warnings/route behaviour without needing
 *     to actually fly or connect X-Plane/MSFS. Hold +/- buttons to adjust
 *     heading, speed, and altitude — see SimControlPanel.tsx.
 *
 * Connecting a real external simulator (X-Plane/MSFS via UDP or WebSocket)
 * is a separate, less-frequently-used flow — stays in Settings
 * (SimConnectSheet), linked from here as a hint rather than duplicated.
 */

import React, { useState } from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import { NativeSheet } from './NativeSheet'
import { Ionicons } from '@expo/vector-icons'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

export type FlightModeStatus = 'off' | 'gps' | 'sim'

interface Props {
  status: FlightModeStatus
  onStartGps: () => void
  onStartSim: () => void
  onStop: () => void
}

export function FlightModeSheet({ status, onStartGps, onStartSim, onStop }: Props) {
  const scaledTheme = useScaledTheme()
  const styles = useThemedStyles(makeStyles)
  const [open, setOpen] = useState(false)
  const active = status !== 'off'

  return (
    <>
      <TouchableOpacity
        style={[styles.trigger, active && styles.triggerActive]}
        onPress={() => setOpen(true)}
      >
        <Ionicons
          name={status === 'sim' ? 'game-controller-outline' : 'airplane-outline'}
          size={19}
          color={active ? theme.accentBlue : theme.textSecondary}
        />
      </TouchableOpacity>

      <NativeSheet
        isPresented={open}
        onDismiss={() => setOpen(false)}
        title="Flight Mode"
        testID="flight-mode-sheet"
        height={460}
      >
        {active && (
          <View style={styles.statusBanner}>
            <Text style={styles.statusTxt}>
              {status === 'gps' ? 'Flying \u2014 GPS active' : 'Simulating \u2014 touch controls active'}
            </Text>
            <TouchableOpacity onPress={() => { onStop(); setOpen(false) }}>
              <Text style={styles.stopTxt}>Stop</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.body}>
          <TouchableOpacity
            style={[styles.card, status === 'gps' && styles.cardActive]}
            onPress={() => { onStartGps(); setOpen(false) }}
            disabled={status === 'gps'}
          >
            <Ionicons name="airplane-outline" size={scaledTheme.scale(20)} color={theme.accentBlue} />
            <View style={styles.cardText}>
              <Text style={styles.cardTitle}>Fly</Text>
              <Text style={styles.cardDesc}>Use real GPS position. Keeps the screen awake and follows your aircraft.</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.card, status === 'sim' && styles.cardActive]}
            onPress={() => { onStartSim(); setOpen(false) }}
            disabled={status === 'sim'}
          >
            <Ionicons name="game-controller-outline" size={scaledTheme.scale(20)} color={theme.accentPurple} />
            <View style={styles.cardText}>
              <Text style={styles.cardTitle}>Simulate</Text>
              <Text style={styles.cardDesc}>
                Fly a virtual aircraft with touch controls — no GPS or flight sim required.
                Hold +/− to adjust heading, speed, and altitude.
              </Text>
            </View>
          </TouchableOpacity>

          <Text style={styles.hint}>
            Connecting a real flight simulator (X-Plane, MSFS)? See Settings → Simulator / External GPS.
          </Text>
        </View>
      </NativeSheet>
    </>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  trigger: {
    width:           40,
    height:          40,
    borderRadius:    theme.radiusMd,
    backgroundColor: 'rgba(19,24,36,0.90)',
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    alignItems:      'center' as const,
    justifyContent:  'center' as const,
  },
  triggerActive: { borderColor: theme.accentBlue },
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    backgroundColor:      theme.surfaceSheet,
    borderTopLeftRadius:  theme.scale(20),
    borderTopRightRadius: theme.scale(20),
    borderTopWidth:       1,
    borderColor:          theme.borderDefault,
    maxHeight:            '80%' as const,
  },
  handle: {
    width:           theme.scale(40),
    height:          theme.scale(4),
    borderRadius:    theme.scale(2),
    backgroundColor: theme.borderDefault,
    alignSelf:       'center' as const,
    marginTop:       theme.scale(10),
    marginBottom:    theme.scale(4),
  },
  header: {
    flexDirection:     'row' as const,
    alignItems:        'center' as const,
    justifyContent:    'space-between' as const,
    paddingHorizontal: theme.space4,
    paddingVertical:   theme.space2,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  title: {
    color:      theme.textPrimary,
    fontSize:   theme.textMd,
    fontWeight: '700' as const,
  },
  statusBanner: {
    flexDirection:     'row' as const,
    alignItems:        'center' as const,
    justifyContent:    'space-between' as const,
    paddingHorizontal: theme.space4,
    paddingVertical:   theme.space2,
    backgroundColor:   'rgba(59,130,246,0.08)',
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  statusTxt: {
    color:    theme.accentBlue,
    fontSize: theme.textXs,
  },
  stopTxt: {
    color:      theme.statusDanger,
    fontSize:   theme.textXs,
    fontWeight: '600' as const,
  },
  body: {
    padding: theme.space4,
    gap:     theme.space3,
  },
  card: {
    flexDirection:   'row' as const,
    gap:             theme.space3,
    backgroundColor: theme.surfaceOverlay,
    borderRadius:    theme.radiusMd,
    borderWidth:     1,
    borderColor:     theme.borderSubtle,
    padding:         theme.space3,
  },
  cardActive: {
    borderColor:     theme.accentBlue,
    opacity:         0.6,
  },
  cardText: {
    flex: 1,
    gap:  theme.scale(2),
  },
  cardTitle: {
    color:      theme.textPrimary,
    fontSize:   theme.textSm,
    fontWeight: '700' as const,
  },
  cardDesc: {
    color:      theme.textMuted,
    fontSize:   theme.textXs,
    lineHeight: theme.scale(16),
  },
  hint: {
    color:      theme.textFaint,
    fontSize:   theme.textXs,
    textAlign:  'center' as const,
    lineHeight: theme.scale(16),
  },
 }
}
