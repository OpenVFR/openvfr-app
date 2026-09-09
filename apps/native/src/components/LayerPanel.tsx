/**
 * LayerPanel — floating panel for toggling aviation overlay visibility.
 * Matches the web LayerPanel groups and colour coding.
 */

import React from 'react'
import {
  View, Text, TouchableOpacity, Modal, ScrollView, StyleSheet,
} from 'react-native'
import { theme } from '../styles/theme'
import { AIRSPACE_COLORS as AC } from '@open-vfr/shared/airspaceColors'
import { AERODROME_COLORS, NAVAID_COLORS, WAYPOINT_COLORS, OBSTACLE_COLORS } from '@open-vfr/shared/featureColors'

// ---------------------------------------------------------------------------
// Layer group definitions — mirrors web LAYER_GROUPS structure
// ---------------------------------------------------------------------------
export type LayerState = {
  airspace:   boolean
  aerodromes: boolean
  navaids:    boolean
  waypoints:  boolean
  obstacles:  boolean
  runways:    boolean
}

export const LAYER_DEFAULTS: LayerState = {
  airspace:   true,
  aerodromes: true,
  navaids:    true,
  waypoints:  true,
  obstacles:  true,
  runways:    true,
}

type Group = {
  key:     keyof LayerState
  label:   string
  color:   string
  section: string
}

const GROUPS: Group[] = [
  { key: 'airspace',   label: 'Airspace',   color: AC.cCtrBorder,              section: 'Airspace'    },
  { key: 'aerodromes', label: 'Aerodromes', color: AERODROME_COLORS.default,   section: 'Points'      },
  { key: 'navaids',    label: 'Navaids',    color: NAVAID_COLORS.vor,          section: 'Points'      },
  { key: 'waypoints',  label: 'Waypoints',  color: WAYPOINT_COLORS.mrp,        section: 'Points'      },
  { key: 'obstacles',  label: 'Obstacles',  color: OBSTACLE_COLORS.tower,      section: 'Points'      },
  { key: 'runways',    label: 'Runways',    color: '#c0d0b8',                   section: 'Aerodromes'  },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
interface Props {
  layers:    LayerState
  onChange:  (key: keyof LayerState, on: boolean) => void
}

export function LayerPanel({ layers, onChange }: Props) {
  const [open, setOpen] = React.useState(false)

  let lastSection = ''

  return (
    <>
      {/* Toggle button */}
      <TouchableOpacity style={styles.trigger} onPress={() => setOpen(true)}>
        <Text style={styles.triggerText}>⊞</Text>
      </TouchableOpacity>

      {/* Panel modal */}
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        />
        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>Layers</Text>
            <TouchableOpacity onPress={() => setOpen(false)}>
              <Text style={styles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView>
            {GROUPS.map((g) => {
              const showSection = g.section !== lastSection
              if (showSection) lastSection = g.section
              const on = layers[g.key]
              return (
                <View key={g.key}>
                  {showSection && (
                    <Text style={styles.section}>{g.section.toUpperCase()}</Text>
                  )}
                  <TouchableOpacity
                    style={[styles.row, !on && styles.rowOff]}
                    onPress={() => onChange(g.key, !on)}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.swatch, { backgroundColor: g.color }]} />
                    <Text style={[styles.label, !on && styles.labelOff]}>{g.label}</Text>
                    <Text style={[styles.badge, on ? styles.badgeOn : styles.badgeOff]}>
                      {on ? 'ON' : 'OFF'}
                    </Text>
                  </TouchableOpacity>
                </View>
              )
            })}
          </ScrollView>
        </View>
      </Modal>
    </>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  trigger: {
    width:           36,
    height:          36,
    borderRadius:    theme.radiusMd,
    backgroundColor: 'rgba(19,24,36,0.90)',
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    alignItems:      'center',
    justifyContent:  'center',
  },
  triggerText: {
    color:    theme.textSecondary,
    fontSize: 18,
    lineHeight: 20,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  panel: {
    position:        'absolute',
    top:             60,
    right:           theme.space2,
    width:           220,
    maxHeight:       420,
    backgroundColor: theme.surfacePanel,
    borderRadius:    theme.radiusMd,
    borderWidth:     1,
    borderColor:     theme.borderDefault,
    overflow:        'hidden',
  },
  panelHeader: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'space-between',
    paddingHorizontal: theme.space3,
    paddingVertical:   theme.space2,
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  panelTitle: {
    color:      theme.textPrimary,
    fontSize:   theme.textSm,
    fontWeight: '700',
  },
  closeBtn: {
    color:    theme.textMuted,
    fontSize: theme.textSm,
    padding:  theme.space1,
  },
  section: {
    color:         theme.textFaint,
    fontSize:      theme.textXs,
    fontWeight:    '600',
    letterSpacing: 0.8,
    paddingHorizontal: theme.space3,
    paddingTop:    theme.space2,
    paddingBottom: theme.space1,
  },
  row: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: theme.space3,
    paddingVertical:   theme.space2,
    gap:               theme.space2,
  },
  rowOff: {
    opacity: 0.5,
  },
  swatch: {
    width:        10,
    height:       10,
    borderRadius: 2,
  },
  label: {
    flex:     1,
    color:    theme.textSecondary,
    fontSize: theme.textSm,
  },
  labelOff: {
    color: theme.textMuted,
  },
  badge: {
    fontSize:  theme.textXs,
    fontWeight: '700',
    minWidth:  28,
    textAlign: 'right',
  },
  badgeOn: {
    color: theme.accentBlue,
  },
  badgeOff: {
    color: theme.textFaint,
  },
})
