/**
 * ICAO flight plan for the route and aircraft: per-flight answers, the message
 * and item 19 as text to check and share, and what is still missing. Nothing is
 * sent from here: the text is filed with the ATS service you use.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, TextInput, Share } from 'react-native'
import {
  aerodromeCodes, buildFpl, defaultEobt, EMPTY_ANSWERS, FLIGHT_RULES_LABELS, FLIGHT_TYPE_LABELS, FPL_DEFAULT_KEYS, FPL_JACKETS, FPL_RADIOS, FPL_SURVIVAL,
  fplAircraftPatch, toggleItem, type FlightAnswers, type FlightRules, type FlightType, type FplDefaults, type LevelMode,
} from '@open-vfr/shared/fplMessage'
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'
import type { AircraftProfileDocType, LegOverride } from '../types/db'
import { settings as settingsDb } from '../db'
import { getAerodromes } from '../hooks/useNearbyFrequencies'
import { normaliseIcaoType } from '@open-vfr/shared/icaoFlightPlan'
import { NativeSheet } from './NativeSheet'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'

const KEY = 'ovfr:fplDefaults'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const hhmmText = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
const dayKey = (d: Date) => d.toISOString().slice(0, 10)
const dayLabel = (d: Date) => `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
/** The time of day from "HH:MM" or "HHMM" (UTC), or null. */
function parseHhmm(t: string): { h: number; m: number } | null {
  const m = t.trim().match(/^(\d{1,2}):?(\d{2})$/)
  if (!m) return null
  const h = +m[1]!, mm = +m[2]!
  return h < 24 && mm < 60 ? { h, m: mm } : null
}

type Styles = ReturnType<typeof makeStyles>

/** One chip. `role` radio = one choice among several, checkbox = on / off; a screen reader hears which is chosen. */
function Chip({ label, on, role, onPress, styles, a11yLabel }: {
  label: string; on: boolean; role: 'radio' | 'checkbox'; onPress: () => void; styles: Styles; a11yLabel?: string
}) {
  return (
    <TouchableOpacity style={[styles.chip, on && styles.chipOn]} onPress={onPress} accessibilityRole={role}
      accessibilityLabel={a11yLabel ?? label} accessibilityState={role === 'radio' ? { selected: on } : { checked: on }}>
      <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{label}</Text>
    </TouchableOpacity>
  )
}

/** A row of chips: pick one (`radio`) or any number (`checkbox`) from `items` of [value, label]. */
function ChipGroup({ items, isOn, onPress, role, styles }: {
  items: readonly (readonly [string, string])[]; isOn: (v: string) => boolean; onPress: (v: string) => void; role: 'radio' | 'checkbox'; styles: Styles
}) {
  return (
    <View style={styles.row} accessibilityRole={role === 'radio' ? 'radiogroup' : undefined}>
      {items.map(([v, l]) => <Chip key={v} label={l} on={isOn(v)} role={role} onPress={() => onPress(v)} styles={styles} />)}
    </View>
  )
}

export function FlightPlanSheet({ visible, onClose, waypoints, legOverrides, aircraft: aircraftProp, legWinds, takeoffTime, alternateIcao, accountName, onSaveAircraft }: {
  visible: boolean
  onClose: () => void
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraft: AircraftProfileDocType
  legWinds?: ({ dirDeg: number; speedKts: number } | null)[]
  takeoffTime: Date | null
  alternateIcao?: string
  accountName?: string
  /** Saves the aircraft the way the aircraft list does (local store, list refresh, cloud sync). */
  onSaveAircraft: (doc: AircraftProfileDocType) => Promise<void>
}) {
  const styles = useThemedStyles(makeStyles)
  // The aircraft as edited here: details missing for the plan can be filled in and saved to the profile.
  const [aircraft, setAircraft] = useState(aircraftProp)
  const [saved, setSaved] = useState(true)
  const [saveError, setSaveError] = useState('')
  const [showMore, setShowMore] = useState(false)
  useEffect(() => { setAircraft(aircraftProp); setSaved(true) }, [aircraftProp])
  const setAc = (patch: Partial<AircraftProfileDocType>) => { setAircraft(a => ({ ...a, ...patch })); setSaved(false); setSaveError('') }
  const saveAircraft = () => {
    onSaveAircraft({ ...aircraftProp, ...fplAircraftPatch(aircraft), updatedAt: Date.now() })
      .then(() => { setSaved(true); setSaveError('') })
      .catch(() => setSaveError('Could not save to the aircraft profile. The plan below still uses what you typed.'))
  }
  const equipMode = aircraft.equipment?.length === 1 && ['N', 'S'].includes(aircraft.equipment[0]!) ? aircraft.equipment[0]! : aircraft.equipment?.length ? 'custom' : 'unset'

  const [flight, setFlight] = useState<FlightAnswers>(() => ({
    ...EMPTY_ANSWERS, eobt: takeoffTime ?? defaultEobt(), alternate: alternateIcao, pilotName: accountName ?? '',
  }))
  const set = <K extends keyof FlightAnswers>(k: K, v: FlightAnswers[K]) => setFlight(f => ({ ...f, [k]: v }))
  const [timeText, setTimeText] = useState(() => hhmmText(flight.eobt))
  // The off-block time is set by day chips, a time field and step buttons (all UTC).
  const setEobt = (d: Date) => { set('eobt', d); setTimeText(hhmmText(d)) }
  const stepEobt = (mins: number) => setEobt(new Date(flight.eobt.getTime() + mins * 60_000))
  const days = useMemo(() => {
    const today = new Date()
    const y = today.getUTCFullYear(), m = today.getUTCMonth(), d = today.getUTCDate()
    return Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(y, m, d + i)))
  }, [])

  // What stays the same from flight to flight.
  useEffect(() => {
    void settingsDb.get<Partial<FplDefaults>>(KEY).then(s => { if (s) setFlight(f => ({ ...f, ...s, pilotName: s.pilotName || f.pilotName })) }).catch(() => {})
  }, [])
  useEffect(() => {
    const d = Object.fromEntries(FPL_DEFAULT_KEYS.map(k => [k, flight[k]])) as FplDefaults
    void settingsDb.set(KEY, d).catch(() => {})
  }, [flight.pilotName, flight.pilotPhone, flight.emergencyRadio, flight.survival, flight.jackets, flight.dinghies])

  // The known aerodromes, so only real ones are written as codes (undefined while loading or when they could not be loaded).
  const [aerodromes, setAerodromes] = useState<Set<string> | undefined>(undefined)
  useEffect(() => {
    let live = true
    void getAerodromes().then(list => { if (live && list) setAerodromes(new Set(list.map(a => a.icao.toUpperCase()))) }).catch(() => {})
    return () => { live = false }
  }, [])
  const fpl = useMemo(() => buildFpl({ waypoints, legOverrides, aircraft, legWinds, flight, ...(aerodromes ? { aerodromes } : {}) }), [waypoints, legOverrides, aircraft, legWinds, flight, aerodromes])
  const bad = parseHhmm(timeText) === null
  const toDay = (d: Date) => new Date(d.getTime() + (flight.eobt.getTime() - Date.UTC(flight.eobt.getUTCFullYear(), flight.eobt.getUTCMonth(), flight.eobt.getUTCDate())))

  return (
    <NativeSheet isPresented={visible} onDismiss={onClose} title="Export ICAO flight plan" testID="flight-plan-sheet" contentContainerStyle={styles.body}>
      <Text style={styles.hint}>A draft built from your route and aircraft. Fill in what is asked, check the list, then share it into the filing service you use. Nothing is sent from OpenVFR.</Text>

      <Text style={styles.outTitle}>Aircraft details for the plan</Text>
      <Text style={styles.label}>Registration</Text>
      <TextInput accessibilityLabel="Registration" style={styles.input} value={aircraft.registration} autoCapitalize="characters" autoCorrect={false} onChangeText={t => setAc({ registration: t.toUpperCase() })} />
      <Text style={styles.label}>ICAO type (or ZZZZ)</Text>
      <TextInput accessibilityLabel="ICAO type, or ZZZZ" style={styles.input} value={aircraft.icaoType ?? ''} autoCapitalize="characters" autoCorrect={false} maxLength={4} onChangeText={t => setAc({ icaoType: normaliseIcaoType(t) })} />
      <Text style={styles.label}>Colour and markings</Text>
      <TextInput accessibilityLabel="Colour and markings" style={styles.input} value={aircraft.colour ?? ''} onChangeText={t => setAc({ colour: t })} />
      <Text style={styles.label}>Transponder</Text>
      <ChipGroup styles={styles} role="radio" isOn={v => (aircraft.transponder ?? '') === v}
        items={[['', 'Not set'], ['none', 'None'], ['A', 'Mode A'], ['C', 'Mode C'], ['S', 'Mode S']]}
        onPress={v => setAc({ transponder: (v || undefined) as AircraftProfileDocType['transponder'] })} />
      <Text style={styles.label}>Radio / nav{equipMode === 'custom' ? ' (chosen letters: edit in the aircraft profile)' : ''}</Text>
      <ChipGroup styles={styles} role="radio" isOn={v => equipMode === v}
        items={[['unset', 'Not set'], ['N', 'None (N)'], ['S', 'Standard (S)']]}
        onPress={v => setAc({ equipment: v === 'unset' ? undefined : [v], hasRadio: undefined })} />
      {!saved && <TouchableOpacity style={styles.btn} onPress={saveAircraft}><Text style={styles.btnTxt}>Save to the aircraft profile</Text></TouchableOpacity>}
      {!!saveError && <Text style={styles.errorTxt} accessibilityRole="alert">{saveError}</Text>}

      <Text style={styles.label}>Flight rules</Text>
      <ChipGroup styles={styles} role="radio" isOn={v => flight.rules === v}
        items={(Object.keys(FLIGHT_RULES_LABELS) as FlightRules[]).map(r => [r, `${r}: ${FLIGHT_RULES_LABELS[r]}`] as const)}
        onPress={v => set('rules', v as FlightRules)} />
      <Text style={styles.label}>Type of flight</Text>
      <ChipGroup styles={styles} role="radio" isOn={v => flight.type === v}
        items={(Object.keys(FLIGHT_TYPE_LABELS) as FlightType[]).map(t => [t, `${t}: ${FLIGHT_TYPE_LABELS[t].split(' (')[0]}`] as const)}
        onPress={v => set('type', v as FlightType)} />

      <Text style={styles.label}>Cruising level</Text>
      <ChipGroup styles={styles} role="radio" isOn={v => flight.levelMode === v}
        items={[['VFR', 'VFR (word only)'], ['planned', 'Altitudes from the route']]}
        onPress={v => set('levelMode', v as LevelMode)} />

      <Text style={styles.label}>Off-block date (UTC)</Text>
      <ChipGroup styles={styles} role="radio" isOn={v => v === dayKey(flight.eobt)}
        items={days.map(d => [dayKey(d), dayLabel(d)] as const)}
        onPress={v => { const d = days.find(x => dayKey(x) === v); if (d) setEobt(toDay(d)) }} />
      <Text style={styles.label}>Off-block time (UTC, HH:MM)</Text>
      <View style={styles.row}>
        <TouchableOpacity style={styles.chip} accessibilityRole="button" accessibilityLabel="1 hour earlier" onPress={() => stepEobt(-60)}><Text style={styles.chipTxt}>−1 h</Text></TouchableOpacity>
        <TouchableOpacity style={styles.chip} accessibilityRole="button" accessibilityLabel="15 minutes earlier" onPress={() => stepEobt(-15)}><Text style={styles.chipTxt}>−15</Text></TouchableOpacity>
        <TextInput accessibilityLabel="Off-block time in UTC, hours and minutes" style={[styles.input, styles.timeBox, bad && styles.inputBad]} value={timeText} keyboardType="number-pad" maxLength={5} placeholder="HHMM" autoCorrect={false}
          onChangeText={t => {
            setTimeText(t)
            const p = parseHhmm(t)
            if (p) set('eobt', new Date(Date.UTC(flight.eobt.getUTCFullYear(), flight.eobt.getUTCMonth(), flight.eobt.getUTCDate(), p.h, p.m)))
          }} />
        <TouchableOpacity style={styles.chip} accessibilityRole="button" accessibilityLabel="15 minutes later" onPress={() => stepEobt(15)}><Text style={styles.chipTxt}>+15</Text></TouchableOpacity>
        <TouchableOpacity style={styles.chip} accessibilityRole="button" accessibilityLabel="1 hour later" onPress={() => stepEobt(60)}><Text style={styles.chipTxt}>+1 h</Text></TouchableOpacity>
      </View>
      <Text style={styles.label}>Alternate (ICAO)</Text>
      <TextInput accessibilityLabel="Alternate aerodrome, ICAO code" style={styles.input} value={flight.alternate ?? ''} autoCapitalize="characters" maxLength={4} onChangeText={t => set('alternate', t.toUpperCase() || undefined)} />
      <Text style={styles.label}>Persons on board</Text>
      <TextInput accessibilityLabel="Persons on board" style={[styles.input, flight.personsUnknown && styles.inputOff]} editable={!flight.personsUnknown} value={String(flight.personsOnBoard)} keyboardType="number-pad" onChangeText={t => set('personsOnBoard', Math.max(0, parseInt(t, 10) || 0))} />
      <Text style={styles.label}>Pilot in command</Text>
      <TextInput accessibilityLabel="Pilot in command" style={styles.input} value={flight.pilotName} onChangeText={t => set('pilotName', t)} />
      <Text style={styles.label}>Phone (reachable until EOBT)</Text>
      <TextInput accessibilityLabel="Phone number reachable until the off-block time" style={styles.input} value={flight.pilotPhone} keyboardType="phone-pad" onChangeText={t => set('pilotPhone', t)} />

      <Text style={styles.label}>Emergency radio</Text>
      <ChipGroup styles={styles} role="checkbox" isOn={v => flight.emergencyRadio.includes(v as 'U')} items={FPL_RADIOS} onPress={v => set('emergencyRadio', toggleItem(flight.emergencyRadio, v as 'U'))} />
      <Text style={styles.label}>Survival equipment</Text>
      <ChipGroup styles={styles} role="checkbox" isOn={v => flight.survival.includes(v as 'P')} items={FPL_SURVIVAL} onPress={v => set('survival', toggleItem(flight.survival, v as 'P'))} />
      <Text style={styles.label}>Life jackets</Text>
      <ChipGroup styles={styles} role="checkbox" isOn={v => flight.jackets.includes(v as 'L')} items={FPL_JACKETS} onPress={v => set('jackets', toggleItem(flight.jackets, v as 'L'))} />
      <Text style={styles.label}>Life rafts (dinghies)</Text>
      <View style={styles.row}>
        <View style={styles.field}>
          <Text style={styles.subLabel}>Number</Text>
          <TextInput accessibilityLabel="Number of life rafts" style={[styles.input, styles.small]} value={String(flight.dinghies.count)} keyboardType="number-pad" onChangeText={t => set('dinghies', { ...flight.dinghies, count: Math.max(0, parseInt(t, 10) || 0) })} />
        </View>
        <View style={styles.field}>
          <Text style={styles.subLabel}>Capacity (persons)</Text>
          <TextInput accessibilityLabel="Total capacity of the life rafts, in persons" style={[styles.input, styles.small]} value={String(flight.dinghies.capacity)} keyboardType="number-pad" onChangeText={t => set('dinghies', { ...flight.dinghies, capacity: Math.max(0, parseInt(t, 10) || 0) })} />
        </View>
        <View style={[styles.field, styles.grow]}>
          <Text style={styles.subLabel}>Colour</Text>
          <TextInput accessibilityLabel="Colour of the life rafts" style={styles.input} value={flight.dinghies.colour} placeholder="Colour" onChangeText={t => set('dinghies', { ...flight.dinghies, colour: t })} />
        </View>
        <Chip label="With canopy" on={flight.dinghies.covered} role="checkbox" styles={styles} onPress={() => set('dinghies', { ...flight.dinghies, covered: !flight.dinghies.covered })} />
      </View>
      <Text style={styles.label}>Remarks</Text>
      <TextInput accessibilityLabel="Remarks" style={styles.input} value={flight.remarks} onChangeText={t => set('remarks', t)} />
      <Text style={styles.label}>Other information</Text>
      <View style={styles.row}>
        <Chip label="Persons not known yet (TBN)" on={!!flight.personsUnknown} role="checkbox" styles={styles} onPress={() => set('personsUnknown', !flight.personsUnknown)} />
        <Chip label="Life jackets, no extras (JACKETS)" on={!!flight.jacketsPlain} role="checkbox" styles={styles} onPress={() => set('jacketsPlain', !flight.jacketsPlain)} />
      </View>

      {fpl.problems.length > 0 && (
        <View style={styles.problems}>
          <Text style={styles.problemsTitle}>Check before you file:</Text>
          {fpl.problems.map(p => <Text key={p} style={styles.problemsTxt}>• {p}</Text>)}
        </View>
      )}
      {!!fpl.text && (
        <>
          <Text style={styles.outTitle}>Flight plan to paste into a filing form's import (item 19 inside)</Text>
          <Text selectable style={styles.out}>{fpl.importText}</Text>
          <TouchableOpacity style={styles.btn} onPress={() => { void Share.share({ message: fpl.importText }) }}><Text style={styles.btnTxt}>Share</Text></TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" onPress={() => setShowMore(v => !v)}><Text style={styles.label}>{showMore ? 'Hide other formats' : 'More formats'}</Text></TouchableOpacity>
          {showMore && (
            <>
              <Text style={styles.outTitle}>Flight plan message</Text>
              <Text selectable style={styles.out}>{fpl.text}</Text>
              <TouchableOpacity style={styles.btn} onPress={() => { void Share.share({ message: fpl.text }) }}><Text style={styles.btnTxt}>Share message</Text></TouchableOpacity>
              <Text style={styles.outTitle}>Item 19, for the filing form</Text>
              <Text selectable style={styles.out}>{fpl.supplementary.join('\n')}</Text>
              <TouchableOpacity style={styles.btn} onPress={() => { void Share.share({ message: fpl.supplementary.join('\n') }) }}><Text style={styles.btnTxt}>Share item 19</Text></TouchableOpacity>
            </>
          )}
        </>
      )}
    </NativeSheet>
  )
}

function makeStyles(theme: ScaledTheme) {
  return {
    body: { paddingHorizontal: theme.space4, paddingTop: theme.space3, paddingBottom: theme.space5, gap: 4 },
    hint: { color: theme.textFaint, fontSize: theme.textXs, marginBottom: theme.space2 },
    label: { color: theme.textMuted, fontSize: theme.textXs, marginTop: theme.space2 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
    chip: { paddingHorizontal: theme.space2, paddingVertical: 5, borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.borderDefault, backgroundColor: theme.surfaceOverlay },
    chipOn: { borderColor: theme.accentBlue, backgroundColor: 'rgba(147,197,253,0.18)' },
    chipTxt: { color: theme.textSecondary, fontSize: theme.textXs },
    chipTxtOn: { color: theme.accentBlue },
    input: { backgroundColor: theme.surfaceOverlay, borderWidth: 1, borderColor: theme.borderDefault, borderRadius: theme.radiusSm, paddingHorizontal: theme.space2, paddingVertical: 7, color: theme.textPrimary, fontSize: theme.textSm },
    inputBad: { borderColor: theme.statusDanger },
    inputOff: { opacity: 0.45 },
    errorTxt: { color: theme.statusDanger, fontSize: theme.textXs },
    field: { gap: 2 },
    subLabel: { color: theme.textFaint, fontSize: theme.textXs },
    small: { width: 56 },
    timeBox: { width: 96, textAlign: 'center' },
    grow: { flexGrow: 1, minWidth: 90 },
    problems: { marginTop: theme.space3, padding: theme.space2, borderLeftWidth: 3, borderLeftColor: theme.statusWarn, gap: 2 },
    problemsTitle: { color: theme.textPrimary, fontSize: theme.textXs, fontWeight: '700' },
    problemsTxt: { color: theme.textSecondary, fontSize: theme.textXs },
    outTitle: { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '700', marginTop: theme.space3 },
    out: { color: theme.textPrimary, fontSize: theme.textXs, padding: theme.space2, borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.borderDefault, backgroundColor: theme.surfaceOverlay },
    btn: { alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: theme.space3, borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.accentBlue, marginTop: theme.space1 },
    btnTxt: { color: theme.accentBlue, fontSize: theme.textSm },
  } as const
}
