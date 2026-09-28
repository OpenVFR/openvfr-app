/**
 * AircraftEditSheet — create/edit an aircraft profile on-device.
 *
 * Native parity with web's AircraftLibrary.tsx form (no POH import here —
 * that stays server-proxied and web-only for now). Saves via useAircraftSync's
 * pushAircraft (local AsyncStorage + best-effort cloud upsert).
 */

import React, { useEffect, useState } from 'react'
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput, ScrollView,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as Crypto from 'expo-crypto'
import type { AircraftProfileDocType, AircraftCategory } from '../types/db'
import { NativeSheet } from './NativeSheet'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

const CATEGORIES: { value: AircraftCategory; label: string }[] = [
  { value: 'SEP',    label: 'SEP'    },
  { value: 'MEP',    label: 'MEP'    },
  { value: 'MICRO',  label: 'Micro'  },
  { value: 'GYRO',   label: 'Gyro'   },
  { value: 'HELI',   label: 'Heli'   },
  { value: 'TMG',    label: 'TMG'    },
  { value: 'GLIDER', label: 'Glider' },
]

const HAS_FUEL   = (c: AircraftCategory) => c !== 'GLIDER'
const HAS_ENGINE = (c: AircraftCategory) => c !== 'GLIDER'
const HAS_GLIDE  = (c: AircraftCategory) => c === 'GLIDER' || c === 'TMG'

type FormState = {
  name: string; registration: string; icaoType: string; category: AircraftCategory
  cruiseAltFt: string; cruiseIas: string
  fuelBurnLhr: string; maxFuelL: string; taxiFuelL: string; landingFuelL: string
  holdingMin: string; contingencyPct: string
  serviceCeilingFt: string; rocSlFpm: string; rocCeilingFpm: string
  climbIas: string; climbFuelLhr: string
  descentFpm: string; descentIas: string; descentFuelLhr: string
  bestGlideIas: string; glideRatio: string
}

const EMPTY: FormState = {
  name: '', registration: '', icaoType: '', category: 'SEP',
  cruiseAltFt: '5000', cruiseIas: '100',
  fuelBurnLhr: '25', maxFuelL: '150', taxiFuelL: '5', landingFuelL: '20',
  holdingMin: '30', contingencyPct: '10',
  serviceCeilingFt: '14000', rocSlFpm: '700', rocCeilingFpm: '100',
  climbIas: '80', climbFuelLhr: '30',
  descentFpm: '500', descentIas: '100', descentFuelLhr: '15',
  bestGlideIas: '65', glideRatio: '30',
}

function toForm(p: AircraftProfileDocType): FormState {
  return {
    name: p.name, registration: p.registration, icaoType: p.icaoType, category: p.category ?? 'SEP',
    cruiseAltFt: String(p.cruiseAltFt), cruiseIas: String(p.cruiseIas),
    fuelBurnLhr: String(p.fuelBurnLhr), maxFuelL: String(p.maxFuelL),
    taxiFuelL: String(p.taxiFuelL), landingFuelL: String(p.landingFuelL),
    holdingMin: String(p.holdingMin), contingencyPct: String(p.contingencyPct),
    serviceCeilingFt: String(p.serviceCeilingFt ?? 0), rocSlFpm: String(p.rocSlFpm ?? 0),
    rocCeilingFpm: String(p.rocCeilingFpm ?? 0), climbIas: String(p.climbIas ?? 0),
    climbFuelLhr: String(p.climbFuelLhr ?? 0), descentFpm: String(p.descentFpm ?? 0),
    descentIas: String(p.descentIas ?? 0), descentFuelLhr: String(p.descentFuelLhr ?? 0),
    bestGlideIas: String(p.bestGlideIas ?? 0), glideRatio: String(p.glideRatio ?? 0),
  }
}

function num(s: string, fallback = 0): number {
  const n = parseFloat(s)
  return isNaN(n) ? fallback : n
}

interface Props {
  /** null = create new; an existing profile = edit */
  profile: AircraftProfileDocType | null
  visible: boolean
  onClose: () => void
  onSave:  (doc: AircraftProfileDocType) => void
}

export function AircraftEditSheet({ profile, visible, onClose, onSave }: Props) {
  const styles = useThemedStyles(makeStyles)
  const [form, setForm]     = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (visible) { setForm(profile ? toForm(profile) : EMPTY); setErrors({}) }
  }, [visible, profile])

  function set<K extends keyof FormState>(key: K, val: FormState[K]) {
    setForm(f => ({ ...f, [key]: val }))
    setErrors(e => { if (!e[key]) return e; const n = { ...e }; delete n[key]; return n })
  }

  function validate(): boolean {
    const e: Record<string, string> = {}
    if (!form.name.trim())         e.name = 'Required'
    if (!form.registration.trim()) e.registration = 'Required'
    if (num(form.cruiseAltFt) <= 0) e.cruiseAltFt = 'Must be > 0'
    if (num(form.cruiseIas)   <= 0) e.cruiseIas   = 'Must be > 0'
    if (HAS_FUEL(form.category)) {
      if (num(form.fuelBurnLhr) <= 0) e.fuelBurnLhr = 'Must be > 0'
      if (num(form.maxFuelL)    <= 0) e.maxFuelL    = 'Must be > 0'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleSave() {
    if (!validate()) return
    const cat = form.category
    const doc: AircraftProfileDocType = {
      id:               profile?.id ?? Crypto.randomUUID(),
      name:             form.name.trim(),
      registration:     form.registration.trim().toUpperCase(),
      icaoType:         form.icaoType.trim().toUpperCase(),
      category:         cat,
      cruiseAltFt:      num(form.cruiseAltFt),
      cruiseIas:        num(form.cruiseIas),
      fuelBurnLhr:      HAS_FUEL(cat) ? num(form.fuelBurnLhr) : 0,
      maxFuelL:         HAS_FUEL(cat) ? num(form.maxFuelL)    : 0,
      taxiFuelL:        HAS_FUEL(cat) ? num(form.taxiFuelL)   : 0,
      landingFuelL:     HAS_FUEL(cat) ? num(form.landingFuelL): 0,
      holdingMin:       HAS_FUEL(cat) ? num(form.holdingMin)  : 0,
      contingencyPct:   HAS_FUEL(cat) ? num(form.contingencyPct) : 0,
      serviceCeilingFt: HAS_ENGINE(cat) ? num(form.serviceCeilingFt) : 0,
      rocSlFpm:         HAS_ENGINE(cat) ? num(form.rocSlFpm)         : 0,
      rocCeilingFpm:    HAS_ENGINE(cat) ? num(form.rocCeilingFpm)    : 0,
      climbIas:         HAS_ENGINE(cat) ? num(form.climbIas)         : 0,
      climbFuelLhr:     HAS_ENGINE(cat) && HAS_FUEL(cat) ? num(form.climbFuelLhr) : 0,
      descentFpm:       HAS_ENGINE(cat) ? num(form.descentFpm) : 0,
      descentIas:       HAS_ENGINE(cat) ? num(form.descentIas) : 0,
      descentFuelLhr:   HAS_ENGINE(cat) && HAS_FUEL(cat) ? num(form.descentFuelLhr) : 0,
      bestGlideIas:     HAS_GLIDE(cat) ? num(form.bestGlideIas) : 0,
      glideRatio:       HAS_GLIDE(cat) ? num(form.glideRatio)   : 0,
      updatedAt:        Date.now(),
    }
    onSave(doc)
    onClose()
  }

  return (
    <NativeSheet
      isPresented={visible}
      onDismiss={onClose}
      title={profile ? 'Edit Aircraft' : 'New Aircraft'}
      testID="aircraft-edit-sheet"
      contentContainerStyle={styles.body}
    >
      <SectionLabel text="Identity" />
      <FieldRow label="Name" value={form.name} error={errors.name} onChange={v => set('name', v)} placeholder="e.g. My Cessna 172" />
      <FieldRow label="Registration" value={form.registration} error={errors.registration} onChange={v => set('registration', v)} placeholder="SE-ABC" autoCap />
      <FieldRow label="ICAO Type" value={form.icaoType} onChange={v => set('icaoType', v)} placeholder="C172" autoCap />

      <Text style={styles.fieldLabel}>Category</Text>
      <View style={styles.catRow}>
        {CATEGORIES.map(c => (
          <TouchableOpacity
            key={c.value}
            style={[styles.catChip, form.category === c.value && styles.catChipActive]}
            onPress={() => set('category', c.value)}
          >
            <Text style={[styles.catChipTxt, form.category === c.value && styles.catChipTxtActive]}>{c.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <SectionLabel text="Performance" />
      <FieldRow label="Cruise Alt" unit="ft" value={form.cruiseAltFt} error={errors.cruiseAltFt} numeric onChange={v => set('cruiseAltFt', v)} />
      <FieldRow label="Cruise IAS" unit="kts" value={form.cruiseIas} error={errors.cruiseIas} numeric onChange={v => set('cruiseIas', v)} />

      {HAS_FUEL(form.category) && (
        <>
          <SectionLabel text="Fuel" />
          <FieldRow label="Burn" unit="L/h" value={form.fuelBurnLhr} error={errors.fuelBurnLhr} numeric onChange={v => set('fuelBurnLhr', v)} />
          <FieldRow label="Max capacity" unit="L" value={form.maxFuelL} error={errors.maxFuelL} numeric onChange={v => set('maxFuelL', v)} />
          <FieldRow label="Taxi / T/O" unit="L" value={form.taxiFuelL} numeric onChange={v => set('taxiFuelL', v)} />
          <FieldRow label="Reserve LDG" unit="L" value={form.landingFuelL} numeric onChange={v => set('landingFuelL', v)} />
          <FieldRow label="Holding" unit="min" value={form.holdingMin} numeric onChange={v => set('holdingMin', v)} />
          <FieldRow label="Contingency" unit="%" value={form.contingencyPct} numeric onChange={v => set('contingencyPct', v)} />
        </>
      )}

      {HAS_ENGINE(form.category) && (
        <>
          <SectionLabel text="Climb / Descent" />
          <FieldRow label="Service ceiling" unit="ft" value={form.serviceCeilingFt} numeric onChange={v => set('serviceCeilingFt', v)} />
          <FieldRow label="RoC at SL" unit="fpm" value={form.rocSlFpm} numeric onChange={v => set('rocSlFpm', v)} />
          <FieldRow label="RoC at ceiling" unit="fpm" value={form.rocCeilingFpm} numeric onChange={v => set('rocCeilingFpm', v)} />
          <FieldRow label="Climb IAS" unit="kts" value={form.climbIas} numeric onChange={v => set('climbIas', v)} />
          {HAS_FUEL(form.category) && (
            <FieldRow label="Climb fuel burn" unit="L/h" value={form.climbFuelLhr} numeric onChange={v => set('climbFuelLhr', v)} />
          )}
          <FieldRow label="Descent rate" unit="fpm" value={form.descentFpm} numeric onChange={v => set('descentFpm', v)} />
          <FieldRow label="Descent IAS" unit="kts" value={form.descentIas} numeric onChange={v => set('descentIas', v)} />
          {HAS_FUEL(form.category) && (
            <FieldRow label="Descent fuel burn" unit="L/h" value={form.descentFuelLhr} numeric onChange={v => set('descentFuelLhr', v)} />
          )}
        </>
      )}

      {HAS_GLIDE(form.category) && (
        <>
          <SectionLabel text="Glide" />
          <FieldRow label="Best glide IAS" unit="kts" value={form.bestGlideIas} numeric onChange={v => set('bestGlideIas', v)} />
          <FieldRow label="Glide ratio" unit=":1" value={form.glideRatio} numeric onChange={v => set('glideRatio', v)} />
        </>
      )}

      <View style={styles.actions}>
        <TouchableOpacity style={styles.btn} onPress={onClose}>
          <Text style={styles.btnTxt}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={handleSave}>
          <Text style={styles.btnPrimaryTxt}>{profile ? 'Save' : 'Add'}</Text>
        </TouchableOpacity>
      </View>
      <View style={{ height: 24 }} />
    </NativeSheet>
  )
}

function SectionLabel({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles)
  return <Text style={styles.sectionLabel}>{text}</Text>
}

function FieldRow({ label, unit, value, error, numeric, autoCap, placeholder, onChange }: {
  label: string; unit?: string; value: string; error?: string
  numeric?: boolean; autoCap?: boolean; placeholder?: string
  onChange: (v: string) => void
}) {
  const styles = useThemedStyles(makeStyles)
  return (
    <View style={styles.fieldWrap}>
      <View style={styles.fieldLabelRow}>
        <Text style={styles.fieldLabel}>{label}{unit ? ` (${unit})` : ''}</Text>
        {error && <Text style={styles.fieldErr}>{error}</Text>}
      </View>
      <TextInput
        style={[styles.input, error ? styles.inputError : null]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.textFaint}
        keyboardType={numeric ? 'numeric' : 'default'}
        autoCapitalize={autoCap ? 'characters' : 'none'}
      />
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
 return {
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: theme.surfaceSheet,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderColor: theme.borderDefault,
    maxHeight: '90%',
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: theme.borderDefault,
    alignSelf: 'center', marginTop: 10, marginBottom: 4,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.space4, paddingVertical: theme.space2,
    borderBottomWidth: 1, borderBottomColor: theme.borderSubtle,
  },
  title: { color: theme.textPrimary, fontSize: theme.textMd, fontWeight: '700' },
  body: { paddingHorizontal: theme.space4, paddingTop: theme.space3 },
  sectionLabel: {
    color: theme.textFaint, fontSize: theme.textXs, fontWeight: '700',
    letterSpacing: 0.8, marginTop: theme.space3, marginBottom: theme.space1,
  },
  fieldWrap: { marginBottom: theme.space2 },
  fieldLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fieldLabel: { color: theme.textMuted, fontSize: theme.textXs, marginBottom: 3 },
  fieldErr: { color: theme.statusDanger, fontSize: theme.textXs },
  input: {
    backgroundColor: theme.surfaceOverlay, borderWidth: 1, borderColor: theme.borderDefault,
    borderRadius: theme.radiusSm, paddingHorizontal: theme.space2, paddingVertical: 7,
    color: theme.textPrimary, fontSize: theme.textSm,
  },
  inputError: { borderColor: theme.statusDanger },
  catRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: theme.space2 },
  catChip: {
    paddingHorizontal: theme.space2, paddingVertical: 5,
    borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.borderDefault,
    backgroundColor: theme.surfaceOverlay,
  },
  catChipActive: { borderColor: theme.accentBlue, backgroundColor: 'rgba(59,130,246,0.15)' },
  catChipTxt: { color: theme.textMuted, fontSize: theme.textXs },
  catChipTxtActive: { color: theme.accentBlue, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: theme.space2, marginTop: theme.space4 },
  btn: {
    flex: 1, alignItems: 'center', paddingVertical: 10,
    borderRadius: theme.radiusMd, borderWidth: 1, borderColor: theme.borderDefault,
  },
  btnTxt: { color: theme.textSecondary, fontSize: theme.textSm, fontWeight: '600' },
  btnPrimary: { backgroundColor: theme.accentBlue, borderColor: theme.accentBlue },
  btnPrimaryTxt: { color: '#fff', fontSize: theme.textSm, fontWeight: '700' },
} as const
}
