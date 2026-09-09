/**
 * FrequencyPanel — compact icon-button trigger (matches MapDisplaySheet /
 * SimConnectSheet's 40×40 square button convention) + expandable list.
 *
 * Previously an always-visible full-width text strip that permanently ate
 * vertical screen space above the map whenever a nearby aerodrome existed.
 * Now a single small headset/radio icon button, stacked above the layers
 * button — tap to open the same bottom sheet with all aerodromes within
 * 25 NM and their full frequency lists (TWR, APP, GND, ATIS, FIS…).
 *
 * No map tapping required — frequencies are contextual to GPS position.
 */

import React, { useState } from 'react'
import {
  View, Text, TouchableOpacity, Modal, ScrollView, StyleSheet,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { NearbyAerodrome } from '../hooks/useNearbyFrequencies'
import { theme } from '../styles/theme'

// Service label colours
const SVC_COLOR: Record<string, string> = {
  TWR:    '#3b82f6',  // blue
  AFIS:   '#3b82f6',
  APP:    '#8b5cf6',  // purple
  DEP:    '#8b5cf6',
  GND:    '#10b981',  // green
  SMC:    '#10b981',
  ATIS:   '#f59e0b',  // amber
  FIS:    '#06b6d4',  // cyan
  INFO:   '#06b6d4',
  RDO:    '#94a3b8',  // grey
  RADIO:  '#94a3b8',
  UNICOM: '#94a3b8',
}

function svcColor(svc: string) {
  return SVC_COLOR[svc] ?? theme.textMuted
}

interface Props {
  nearby: NearbyAerodrome[]
}

export function FrequencyPanel({ nearby }: Props) {
  const [open, setOpen] = useState(false)

  const nearest = nearby[0] ?? null

  if (!nearest) return null

  return (
    <>
      {/* Compact trigger — headset icon, badge shows count of aerodromes in range */}
      <TouchableOpacity style={styles.trigger} onPress={() => setOpen(true)} activeOpacity={0.8}>
        <Ionicons name="headset-outline" size={19} color={theme.accentBlue} />
        {nearby.length > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeTxt}>{nearby.length}</Text>
          </View>
        )}
      </TouchableOpacity>

      {/* Bottom sheet */}
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)} />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <Ionicons name="radio-outline" size={16} color={theme.accentBlue} />
            <Text style={styles.headerTitle}>Nearby Frequencies</Text>
            <Text style={styles.headerSub}>{nearby.length} aerodromes within 25 NM</Text>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            {nearby.map((ad, i) => (
              <View key={ad.icao || ad.name} style={[styles.adCard, i > 0 && styles.adCardBorder]}>
                {/* Aerodrome header */}
                <View style={styles.adHeader}>
                  <Text style={styles.adIcao}>{ad.icao}</Text>
                  <Text style={styles.adName} numberOfLines={1}>{ad.name}</Text>
                  <Text style={styles.adDist}>{ad.distNm.toFixed(1)} NM</Text>
                </View>

                {/* Frequencies */}
                {ad.frequencies.length === 0 ? (
                  <Text style={styles.noFreq}>No frequencies on record</Text>
                ) : (
                  <View style={styles.freqList}>
                    {ad.frequencies.map((f, j) => (
                      <View key={j} style={styles.freqRow}>
                        <View style={[styles.svcBadge, { backgroundColor: svcColor(f.service) + '22', borderColor: svcColor(f.service) + '55' }]}>
                          <Text style={[styles.svcTxt, { color: svcColor(f.service) }]}>{f.service}</Text>
                        </View>
                        <Text style={styles.freqMhz}>{f.mhz.toFixed(3)}</Text>
                        {f.callsign && (
                          <Text style={styles.freqCallsign} numberOfLines={1}>{f.callsign}</Text>
                        )}
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ))}
            <View style={{ height: 24 }} />
          </ScrollView>
        </View>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  // ── Compact trigger ───────────────────────────────────────────────────────
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
  badge: {
    position:          'absolute',
    top:               -4,
    right:             -4,
    minWidth:          16,
    height:            16,
    borderRadius:      8,
    backgroundColor:   theme.accentBlue,
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: 3,
  },
  badgeTxt: {
    color:      '#fff',
    fontSize:   9,
    fontWeight: '700',
  },

  // ── Bottom sheet ─────────────────────────────────────────────────────────
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
    maxHeight:          '75%',
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
    gap:               theme.space2,
    paddingHorizontal: theme.space4,
    paddingVertical:   theme.space2,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  headerTitle: {
    color:      theme.textPrimary,
    fontSize:   theme.textMd,
    fontWeight: '700',
    flex:       1,
  },
  headerSub: {
    color:    theme.textFaint,
    fontSize: theme.textXs,
  },

  // ── Aerodrome cards ───────────────────────────────────────────────────────
  adCard: {
    paddingHorizontal: theme.space4,
    paddingVertical:   theme.space3,
    gap:               theme.space2,
  },
  adCardBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.borderSubtle,
  },
  adHeader: {
    flexDirection: 'row',
    alignItems:    'baseline',
    gap:           theme.space2,
  },
  adIcao: {
    color:      theme.textPrimary,
    fontSize:   theme.textMd,
    fontWeight: '800',
    letterSpacing: 1,
    minWidth:   44,
  },
  adName: {
    flex:     1,
    color:    theme.textSecondary,
    fontSize: theme.textXs,
  },
  adDist: {
    color:      theme.accentBlue,
    fontSize:   theme.textXs,
    fontWeight: '600',
  },
  freqList: {
    gap: 4,
  },
  freqRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           theme.space2,
  },
  svcBadge: {
    borderWidth:       1,
    borderRadius:      4,
    paddingHorizontal: 5,
    paddingVertical:   1,
    minWidth:          40,
    alignItems:        'center',
  },
  svcTxt: {
    fontSize:   9,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  freqMhz: {
    color:       theme.textPrimary,
    fontSize:    theme.textSm,
    fontWeight:  '600',
    fontVariant: ['tabular-nums'],
    minWidth:    60,
  },
  freqCallsign: {
    flex:     1,
    color:    theme.textMuted,
    fontSize: theme.textXs,
  },
  noFreq: {
    color:     theme.textFaint,
    fontSize:  theme.textXs,
    fontStyle: 'italic',
  },
})
