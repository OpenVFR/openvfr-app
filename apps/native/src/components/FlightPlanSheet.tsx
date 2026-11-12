/**
 * ICAO flight plan for the route and aircraft: per-flight answers, the message
 * and item 19 as text to check and share, and what is still missing. Nothing is
 * sent from here: the text is filed with the ATS service you use.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, TextInput, Share } from 'react-native'
import { buildFpl, EMPTY_ANSWERS, FLIGHT_RULES_LABELS, FLIGHT_TYPE_LABELS, type FlightAnswers, type FlightRules, type FlightType, type LevelMode } from '@open-vfr/shared/fplMessage'
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'
import type { AircraftProfileDocType, LegOverride } from '../types/db'
import { settings as settingsDb, aircraft as aircraftDb } from '../db'
import { fplAircraftItems, normaliseIcaoType } from '@open-vfr/shared/icaoFlightPlan'
import { NativeSheet } from './NativeSheet'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'

const KEY = 'ovfr:fplDefaults'
type Defaults = Pick<FlightAnswers, 'pilotName' | 'pilotPhone' | 'emergencyRadio' | 'survival' | 'jackets' | 'dinghies'>

const SURVIVAL: [string, string][] = [['P', 'Polar'], ['D', 'Desert'], ['M', 'Maritime'], ['J', 'Jungle']]
const JACKETS: [string, string][] = [['L', 'Light'], ['F', 'Fluorescein'], ['U', 'UHF'], ['V', 'VHF']]
const RADIOS: [string, string][] = [['U', 'UHF'], ['V', 'VHF 121.5'], ['E', 'ELT']]

function toggle<T extends string>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter(x => x !== v) : [...list, v]
}

const utcText = (d: Date) => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`
function parseUtc(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/)
  if (!m) return null
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!))
  return Number.isNaN(d.getTime()) ? null : d
}

export function FlightPlanSheet({ visible, onClose, waypoints, legOverrides, aircraft: aircraftProp, legWinds, takeoffTime, alternateIcao, accountName }: {
  visible: boolean
  onClose: () => void
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraft: AircraftProfileDocType
  legWinds?: ({ dirDeg: number; speedKts: number } | null)[]
  takeoffTime: Date | null
  alternateIcao?: string
  accountName?: string
}) {
  const styles = useThemedStyles(makeStyles)
  // The aircraft as edited here: details missing for the plan can be filled in and saved to the profile.
  const [aircraft, setAircraft] = useState(aircraftProp)
  const [saved, setSaved] = useState(true)
  const [showMore, setShowMore] = useState(false)
  useEffect(() => { setAircraft(aircraftProp); setSaved(true) }, [aircraftProp])
  const setAc = (patch: Partial<AircraftProfileDocType>) => { setAircraft(a => ({ ...a, ...patch })); setSaved(false) }
  const saveAircraft = () => {
    void aircraftDb.upsert({ ...aircraftProp, registration: aircraft.registration, icaoType: aircraft.icaoType, colour: aircraft.colour, transponder: aircraft.transponder, equipment: aircraft.equipment, hasRadio: aircraft.hasRadio, updatedAt: Date.now() }).then(() => setSaved(true)).catch(() => {})
  }
  const equipMode = aircraft.equipment?.length === 1 && ['N', 'S'].includes(aircraft.equipment[0]!) ? aircraft.equipment[0]! : aircraft.equipment?.length ? 'custom' : 'unset'
  const [flight, setFlight] = useState<FlightAnswers>(() => ({
    ...EMPTY_ANSWERS, eobt: takeoffTime ?? new Date(Math.ceil((Date.now() + 30 * 60_000) / 300_000) * 300_000), alternate: alternateIcao, pilotName: accountName ?? '',
  }))
  const [eobtText, setEobtText] = useState(() => utcText(flight.eobt))
  const set = <K extends keyof FlightAnswers>(k: K, v: FlightAnswers[K]) => setFlight(f => ({ ...f, [k]: v }))

  // What stays the same from flight to flight.
  useEffect(() => {
    void settingsDb.get<Partial<Defaults>>(KEY).then(s => { if (s) setFlight(f => ({ ...f, ...s, pilotName: s.pilotName || f.pilotName })) }).catch(() => {})
  }, [])
  useEffect(() => {
    const d: Defaults = { pilotName: flight.pilotName, pilotPhone: flight.pilotPhone, emergencyRadio: flight.emergencyRadio, survival: flight.survival, jackets: flight.jackets, dinghies: flight.dinghies }
    void settingsDb.set(KEY, d).catch(() => {})
  }, [flight.pilotName, flight.pilotPhone, flight.emergencyRadio, flight.survival, flight.jackets, flight.dinghies])

  const fpl = useMemo(() => buildFpl({ waypoints, legOverrides, aircraft, legWinds, flight }), [waypoints, legOverrides, aircraft, legWinds, flight])
  const bad = parseUtc(eobtText) === null

  const Chips = <T extends string>({ items, on, onPress }: { items: [string, string][]; on: readonly T[]; onPress: (c: T) => void }) => (
    <View style={styles.row}>
      {items.map(([c, l]) => (
        <TouchableOpacity key={c} style={[styles.chip, on.includes(c as T) && styles.chipOn]} onPress={() => onPress(c as T)} accessibilityRole="checkbox" accessibilityState={{ checked: on.includes(c as T) }}>
          <Text style={[styles.chipTxt, on.includes(c as T) && styles.chipTxtOn]}>{l}</Text>
        </TouchableOpacity>
      ))}
    </View>
  )

  return (
    <NativeSheet isPresented={visible} onDismiss={onClose} title="Export ICAO flight plan" testID="flight-plan-sheet" contentContainerStyle={styles.body}>
      <Text style={styles.hint}>A draft built from your route and aircraft. Fill in what is asked, check the list, then share it into the filing service you use. Nothing is sent from OpenVFR.</Text>

      <Text style={styles.outTitle}>Aircraft details for the plan</Text>
      <Text style={styles.label}>Registration</Text>
      <TextInput style={styles.input} value={aircraft.registration} autoCapitalize="characters" autoCorrect={false} onChangeText={t => setAc({ registration: t.toUpperCase() })} />
      <Text style={styles.label}>ICAO type (or ZZZZ)</Text>
      <TextInput style={styles.input} value={aircraft.icaoType ?? ''} autoCapitalize="characters" autoCorrect={false} maxLength={4} onChangeText={t => setAc({ icaoType: normaliseIcaoType(t) })} />
      <Text style={styles.label}>Colour and markings</Text>
      <TextInput style={styles.input} value={aircraft.colour ?? ''} onChangeText={t => setAc({ colour: t })} />
      <Text style={styles.label}>Transponder</Text>
      <View style={styles.row}>
        {([['', 'Not set'], ['none', 'None'], ['A', 'Mode A'], ['C', 'Mode C'], ['S', 'Mode S']] as [string, string][]).map(([v, l]) => (
          <TouchableOpacity key={l} style={[styles.chip, (aircraft.transponder ?? '') === v && styles.chipOn]} onPress={() => setAc({ transponder: (v || undefined) as AircraftProfileDocType['transponder'] })}>
            <Text style={[styles.chipTxt, (aircraft.transponder ?? '') === v && styles.chipTxtOn]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.label}>Radio / nav{equipMode === 'custom' ? ' (chosen letters: edit in the aircraft profile)' : ''}</Text>
      <View style={styles.row}>
        {([['unset', 'Not set'], ['N', 'None (N)'], ['S', 'Standard (S)']] as [string, string][]).map(([v, l]) => (
          <TouchableOpacity key={v} style={[styles.chip, equipMode === v && styles.chipOn]} onPress={() => setAc({ equipment: v === 'unset' ? undefined : [v], hasRadio: undefined })}>
            <Text style={[styles.chipTxt, equipMode === v && styles.chipTxtOn]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {!saved && <TouchableOpacity style={styles.btn} onPress={saveAircraft}><Text style={styles.btnTxt}>Save to the aircraft profile</Text></TouchableOpacity>}

      <Text style={styles.label}>Flight rules</Text>
      <View style={styles.row}>
        {(Object.keys(FLIGHT_RULES_LABELS) as FlightRules[]).map(r => (
          <TouchableOpacity key={r} style={[styles.chip, flight.rules === r && styles.chipOn]} onPress={() => set('rules', r)}>
            <Text style={[styles.chipTxt, flight.rules === r && styles.chipTxtOn]}>{r}: {FLIGHT_RULES_LABELS[r]}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.label}>Type of flight</Text>
      <View style={styles.row}>
        {(Object.keys(FLIGHT_TYPE_LABELS) as FlightType[]).map(t => (
          <TouchableOpacity key={t} style={[styles.chip, flight.type === t && styles.chipOn]} onPress={() => set('type', t)}>
            <Text style={[styles.chipTxt, flight.type === t && styles.chipTxtOn]}>{t}: {FLIGHT_TYPE_LABELS[t].split(' (')[0]}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.label}>Cruising level</Text>
      <View style={styles.row}>
        {([['VFR', 'VFR (word only)'], ['planned', 'Altitudes from the route']] as [LevelMode, string][]).map(([v, l]) => (
          <TouchableOpacity key={v} style={[styles.chip, flight.levelMode === v && styles.chipOn]} onPress={() => set('levelMode', v)}>
            <Text style={[styles.chipTxt, flight.levelMode === v && styles.chipTxtOn]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.label}>Off-block time (UTC, YYYY-MM-DD HH:MM)</Text>
      <TextInput style={[styles.input, bad && styles.inputBad]} value={eobtText} autoCapitalize="none" autoCorrect={false}
        onChangeText={t => { setEobtText(t); const d = parseUtc(t); if (d) set('eobt', d) }} />
      <Text style={styles.label}>Alternate (ICAO)</Text>
      <TextInput style={styles.input} value={flight.alternate ?? ''} autoCapitalize="characters" maxLength={4} onChangeText={t => set('alternate', t.toUpperCase() || undefined)} />
      <Text style={styles.label}>Persons on board</Text>
      <TextInput style={styles.input} value={String(flight.personsOnBoard)} keyboardType="number-pad" onChangeText={t => set('personsOnBoard', Math.max(0, parseInt(t, 10) || 0))} />
      <Text style={styles.label}>Pilot in command</Text>
      <TextInput style={styles.input} value={flight.pilotName} onChangeText={t => set('pilotName', t)} />
      <Text style={styles.label}>Phone (reachable until EOBT)</Text>
      <TextInput style={styles.input} value={flight.pilotPhone} keyboardType="phone-pad" onChangeText={t => set('pilotPhone', t)} />

      <Text style={styles.label}>Emergency radio</Text>
      <Chips items={RADIOS} on={flight.emergencyRadio} onPress={c => set('emergencyRadio', toggle(flight.emergencyRadio, c as 'U'))} />
      <Text style={styles.label}>Survival equipment</Text>
      <Chips items={SURVIVAL} on={flight.survival} onPress={c => set('survival', toggle(flight.survival, c as 'P'))} />
      <Text style={styles.label}>Life jackets</Text>
      <Chips items={JACKETS} on={flight.jackets} onPress={c => set('jackets', toggle(flight.jackets, c as 'L'))} />
      <Text style={styles.label}>Life rafts (dinghies): number, total capacity (persons), colour</Text>
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.small]} value={String(flight.dinghies.count)} keyboardType="number-pad" onChangeText={t => set('dinghies', { ...flight.dinghies, count: Math.max(0, parseInt(t, 10) || 0) })} />
        <TextInput style={[styles.input, styles.small]} value={String(flight.dinghies.capacity)} keyboardType="number-pad" onChangeText={t => set('dinghies', { ...flight.dinghies, capacity: Math.max(0, parseInt(t, 10) || 0) })} />
        <TextInput style={[styles.input, styles.grow]} value={flight.dinghies.colour} placeholder="Colour" onChangeText={t => set('dinghies', { ...flight.dinghies, colour: t })} />
        <TouchableOpacity style={[styles.chip, flight.dinghies.covered && styles.chipOn]} onPress={() => set('dinghies', { ...flight.dinghies, covered: !flight.dinghies.covered })}>
          <Text style={[styles.chipTxt, flight.dinghies.covered && styles.chipTxtOn]}>With canopy</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.label}>Remarks</Text>
      <TextInput style={styles.input} value={flight.remarks} onChangeText={t => set('remarks', t)} />
      <Text style={styles.label}>Other information</Text>
      <View style={styles.row}>
        <TouchableOpacity style={[styles.chip, !!flight.personsUnknown && styles.chipOn]} onPress={() => set('personsUnknown', !flight.personsUnknown)} accessibilityRole="checkbox" accessibilityState={{ checked: !!flight.personsUnknown }}>
          <Text style={[styles.chipTxt, !!flight.personsUnknown && styles.chipTxtOn]}>Persons not known yet (TBN)</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.chip, !!flight.jacketsPlain && styles.chipOn]} onPress={() => set('jacketsPlain', !flight.jacketsPlain)} accessibilityRole="checkbox" accessibilityState={{ checked: !!flight.jacketsPlain }}>
          <Text style={[styles.chipTxt, !!flight.jacketsPlain && styles.chipTxtOn]}>Life jackets, no extras (JACKETS)</Text>
        </TouchableOpacity>
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
          <TouchableOpacity onPress={() => setShowMore(v => !v)}><Text style={styles.label}>{showMore ? 'Hide other formats' : 'More formats'}</Text></TouchableOpacity>
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
    small: { width: 56 },
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
