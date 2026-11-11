/**
 * AircraftEditSheet — create/edit an aircraft profile on-device.
 *
 * Native parity with web's AircraftLibrary.tsx form. POH import here goes
 * through the pilot's own AI assistant (share the prompt, paste the answer
 * back); the server-side PDF extraction stays web-only. Saves via
 * useAircraftSync's pushAircraft (local AsyncStorage + best-effort cloud
 * upsert).
 */

import React, { useEffect, useState } from 'react'
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput, ScrollView, Share,
} from 'react-native'
import { buildPohPrompt, parsePohReply, PohReplyError, POH_FIELDS } from '@open-vfr/shared/pohImport'
import { FUEL_CODES, FUEL_LABELS, normalizeFuelCodes, preferenceLabel } from '@open-vfr/shared/fuelTypes'
import type { FuelCode, TransponderMode } from '@open-vfr/shared/types'
import { AppIcon } from './AppIcon'
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
  holdingMin: string; contingencyPct: string; diversionMin: string
  serviceCeilingFt: string; rocSlFpm: string; rocCeilingFpm: string
  climbIas: string; climbFuelLhr: string
  descentFpm: string; descentIas: string; descentFuelLhr: string
  bestGlideIas: string; glideRatio: string
  takeoffSpeedKts: string
  maxCrosswindKts: string
  climbFuelCeilingLhr: string
  unusableFuelL: string
  finalReserveMin: string
  takeoffDist50ftM: string
  landingDist50ftM: string
  vs0Kts: string
  vs1Kts: string
  vxKts: string
  vfeKts: string
  vaKts: string
  vnoKts: string
  vneKts: string
  minRunwayM: string
  hardRunwayOnly: boolean
  fuelTypes: FuelCode[]
  transponder: '' | TransponderMode
  hasRadio: '' | 'yes' | 'no'
}

const EMPTY: FormState = {
  name: '', registration: '', icaoType: '', category: 'SEP',
  cruiseAltFt: '5000', cruiseIas: '100',
  fuelBurnLhr: '25', maxFuelL: '150', taxiFuelL: '5', landingFuelL: '20',
  holdingMin: '30', contingencyPct: '10', diversionMin: '30',
  serviceCeilingFt: '14000', rocSlFpm: '700', rocCeilingFpm: '100',
  climbIas: '80', climbFuelLhr: '30',
  descentFpm: '500', descentIas: '100', descentFuelLhr: '15',
  bestGlideIas: '65', glideRatio: '30',
  takeoffSpeedKts: '0',
  maxCrosswindKts: '0',
  climbFuelCeilingLhr: '0',
  unusableFuelL: '0',
  finalReserveMin: '0',
  takeoffDist50ftM: '0',
  landingDist50ftM: '0',
  vs0Kts: '0',
  vs1Kts: '0',
  vxKts: '0',
  vfeKts: '0',
  vaKts: '0',
  vnoKts: '0',
  vneKts: '0',
  minRunwayM: '0',
  hardRunwayOnly: false,
  fuelTypes: [],
  transponder: '',
  hasRadio: '',
}

function toForm(p: AircraftProfileDocType): FormState {
  return {
    name: p.name, registration: p.registration, icaoType: p.icaoType, category: p.category ?? 'SEP',
    cruiseAltFt: String(p.cruiseAltFt), cruiseIas: String(p.cruiseIas),
    fuelBurnLhr: String(p.fuelBurnLhr), maxFuelL: String(p.maxFuelL),
    taxiFuelL: String(p.taxiFuelL), landingFuelL: String(p.landingFuelL),
    holdingMin: String(p.holdingMin), contingencyPct: String(p.contingencyPct),
    diversionMin: String(p.diversionMin || 30),
    serviceCeilingFt: String(p.serviceCeilingFt ?? 0), rocSlFpm: String(p.rocSlFpm ?? 0),
    rocCeilingFpm: String(p.rocCeilingFpm ?? 0), climbIas: String(p.climbIas ?? 0),
    climbFuelLhr: String(p.climbFuelLhr ?? 0), descentFpm: String(p.descentFpm ?? 0),
    descentIas: String(p.descentIas ?? 0), descentFuelLhr: String(p.descentFuelLhr ?? 0),
    bestGlideIas: String(p.bestGlideIas ?? 0), glideRatio: String(p.glideRatio ?? 0),
    takeoffSpeedKts: String(p.takeoffSpeedKts ?? 0),
    maxCrosswindKts: String(p.maxCrosswindKts ?? 0),
    climbFuelCeilingLhr: String(p.climbFuelCeilingLhr ?? 0),
    unusableFuelL: String(p.unusableFuelL ?? 0),
    finalReserveMin: String(p.finalReserveMin ?? 0),
    takeoffDist50ftM: String(p.takeoffDist50ftM ?? 0),
    landingDist50ftM: String(p.landingDist50ftM ?? 0),
    vs0Kts: String(p.vs0Kts ?? 0),
    vs1Kts: String(p.vs1Kts ?? 0),
    vxKts: String(p.vxKts ?? 0),
    vfeKts: String(p.vfeKts ?? 0),
    vaKts: String(p.vaKts ?? 0),
    vnoKts: String(p.vnoKts ?? 0),
    vneKts: String(p.vneKts ?? 0),
    minRunwayM: String(p.minRunwayM ?? 0),
    hardRunwayOnly: p.hardRunwayOnly === true,
    fuelTypes: normalizeFuelCodes(p.fuelTypes),
    transponder: p.transponder ?? '',
    hasRadio: p.hasRadio === true ? 'yes' : p.hasRadio === false ? 'no' : '',
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
  // POH import through the pilot's AI assistant.
  const [pohOpen, setPohOpen]       = useState(false)
  const [pohReply, setPohReply]     = useState('')
  const [pohError, setPohError]     = useState('')
  const [pohDone, setPohDone]       = useState(false)
  // Per field: why the imported value needs checking (not found, looks wrong).
  const [pohNotes, setPohNotes]     = useState<Partial<Record<keyof FormState, string>>>({})

  useEffect(() => {
    if (visible) {
      setForm(profile ? toForm(profile) : EMPTY); setErrors({})
      setPohOpen(false); setPohReply(''); setPohError(''); setPohDone(false); setPohNotes({})
    }
  }, [visible, profile])

  function set<K extends keyof FormState>(key: K, val: FormState[K]) {
    setForm(f => ({ ...f, [key]: val }))
    setErrors(e => { if (!e[key]) return e; const n = { ...e }; delete n[key]; return n })
    setPohNotes(m => { if (!m[key]) return m; const n = { ...m }; delete n[key]; return n })
  }

  function sharePohPrompt() {
    // The share sheet lists the installed assistant apps; copying is also offered there.
    void Share.share({ message: buildPohPrompt() })
  }

  function applyPohReply() {
    try {
      const r = parsePohReply(pohReply)
      const notes: Partial<Record<keyof FormState, string>> = {}
      const patch: Partial<FormState> = {}
      for (const key of POH_FIELDS) {
        const v = r.values[key]
        const page = r.pages[key] ? ` (POH page ${r.pages[key]})` : ''
        if (v === undefined) notes[key] = 'Not found in POH, verify'
        else {
          patch[key] = v
          if (r.warnings[key]) notes[key] = `${r.warnings[key]}${page}, check against the POH`
        }
      }
      if (r.fuelTypes.length > 0) patch.fuelTypes = r.fuelTypes
      setForm(f => ({ ...f, ...patch }))
      setPohNotes(notes)
      setPohError(''); setPohReply(''); setPohOpen(false); setPohDone(true)
    } catch (err) {
      setPohError(err instanceof PohReplyError ? err.message : 'Could not read the answer.')
    }
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
      // Keep fields this sheet does not edit yet (fuel types, runway limits set on the web).
      ...profile,
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
      diversionMin:     HAS_FUEL(cat) ? num(form.diversionMin, 30) : 0,
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
      takeoffSpeedKts:  num(form.takeoffSpeedKts),
      maxCrosswindKts:  Math.max(0, num(form.maxCrosswindKts)),
      climbFuelCeilingLhr: HAS_ENGINE(cat) && HAS_FUEL(cat) ? Math.max(0, num(form.climbFuelCeilingLhr)) : 0,
      unusableFuelL:    HAS_FUEL(cat) ? Math.max(0, num(form.unusableFuelL)) : 0,
      finalReserveMin:  HAS_FUEL(cat) ? Math.max(0, num(form.finalReserveMin)) : 0,
      takeoffDist50ftM: Math.max(0, num(form.takeoffDist50ftM)),
      landingDist50ftM: Math.max(0, num(form.landingDist50ftM)),
      vs0Kts: Math.max(0, num(form.vs0Kts)),
      vs1Kts: Math.max(0, num(form.vs1Kts)),
      vxKts: Math.max(0, num(form.vxKts)),
      vfeKts: Math.max(0, num(form.vfeKts)),
      vaKts: Math.max(0, num(form.vaKts)),
      vnoKts: Math.max(0, num(form.vnoKts)),
      vneKts: Math.max(0, num(form.vneKts)),
      fuelTypes:        HAS_FUEL(cat) ? form.fuelTypes : [],
      minRunwayM:       Math.max(0, Math.round(num(form.minRunwayM))),
      hardRunwayOnly:   form.hardRunwayOnly,
      transponder:      form.transponder || undefined,
      hasRadio:         form.hasRadio === '' ? undefined : form.hasRadio === 'yes',
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
      <TouchableOpacity
        style={styles.pohToggle}
        onPress={() => setPohOpen(o => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: pohOpen }}
        testID="aircraft-poh-assistant"
      >
        <Text style={styles.pohToggleTxt}>{pohOpen ? 'Hide POH import' : 'Fill from POH with your AI assistant'}</Text>
      </TouchableOpacity>
      {pohOpen && (
        <View style={styles.pohBox}>
          <Text style={styles.pohStep}>1. Share the prompt to your AI assistant app (or copy it).</Text>
          <TouchableOpacity style={styles.pohBtn} onPress={sharePohPrompt}>
            <Text style={styles.btnTxt}>Share prompt</Text>
          </TouchableOpacity>
          <Text style={styles.pohStep}>2. In the assistant, attach the POH PDF and send the prompt.</Text>
          <Text style={styles.pohStep}>3. Copy the whole answer and paste it here:</Text>
          <TextInput
            style={[styles.input, styles.pohInput]}
            value={pohReply}
            onChangeText={t => { setPohReply(t); setPohError('') }}
            placeholder='{"name": "…", "cruiseIas": …}'
            placeholderTextColor={theme.textFaint}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Answer from your AI assistant"
          />
          {!!pohError && <Text style={styles.fieldErr}>{pohError}</Text>}
          <TouchableOpacity
            style={[styles.pohBtn, styles.btnPrimary, !pohReply.trim() && styles.btnDisabled]}
            disabled={!pohReply.trim()}
            onPress={applyPohReply}
          >
            <Text style={styles.btnPrimaryTxt}>Fill in the form</Text>
          </TouchableOpacity>
          <Text style={styles.pohHint}>The PDF stays between you and your assistant.</Text>
        </View>
      )}
      {pohDone && (
        <Text style={styles.pohDone}>
          Fields filled. {Object.keys(pohNotes).length > 0 ? 'Check the marked fields against the POH, then save.' : 'Check them against the POH, then save.'}
        </Text>
      )}

      <SectionLabel text="Identity" />
      <FieldRow label="Name" value={form.name} error={errors.name} note={pohNotes.name} onChange={v => set('name', v)} placeholder="e.g. My Cessna 172" />
      <FieldRow label="Registration" value={form.registration} error={errors.registration} onChange={v => set('registration', v)} placeholder="SE-ABC" autoCap />
      <FieldRow label="ICAO Type" value={form.icaoType} note={pohNotes.icaoType} onChange={v => set('icaoType', v)} placeholder="C172" autoCap />

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
      <FieldRow label="Cruise Alt" unit="ft" value={form.cruiseAltFt} error={errors.cruiseAltFt} note={pohNotes.cruiseAltFt} numeric onChange={v => set('cruiseAltFt', v)} />
      <FieldRow label="Cruise IAS" unit="kts" value={form.cruiseIas} error={errors.cruiseIas} note={pohNotes.cruiseIas} numeric onChange={v => set('cruiseIas', v)} />
      <FieldRow label="Takeoff speed (0 = default)" unit="kts" value={form.takeoffSpeedKts} note={pohNotes.takeoffSpeedKts} numeric onChange={v => set('takeoffSpeedKts', v)} />
      <FieldRow label="Max crosswind (0 = not set)" unit="kts" value={form.maxCrosswindKts} note={pohNotes.maxCrosswindKts} numeric onChange={v => set('maxCrosswindKts', v)} />

      <SectionLabel text="Runway" />
      <FieldRow label="Min runway (0 = no limit)" unit="m" value={form.minRunwayM} numeric onChange={v => set('minRunwayM', v)} />
      <ChipRow
        label="Surface"
        options={[{ v: 'any', label: 'Any' }, { v: 'hard', label: 'Paved only' }]}
        value={form.hardRunwayOnly ? 'hard' : 'any'}
        onChange={v => set('hardRunwayOnly', v === 'hard')}
      />

      <FieldRow label="T/O distance over 50 ft (0 = not set)" unit="m" value={form.takeoffDist50ftM} note={pohNotes.takeoffDist50ftM} numeric onChange={v => set('takeoffDist50ftM', v)} />
      <FieldRow label="LDG distance from 50 ft (0 = not set)" unit="m" value={form.landingDist50ftM} note={pohNotes.landingDist50ftM} numeric onChange={v => set('landingDist50ftM', v)} />

      <SectionLabel text="V-speeds (kt IAS, 0 = not set)" />
      <FieldRow label="Vs0 (flaps)" unit="kts" value={form.vs0Kts} note={pohNotes.vs0Kts} numeric onChange={v => set('vs0Kts', v)} />
      <FieldRow label="Vs1 (clean)" unit="kts" value={form.vs1Kts} note={pohNotes.vs1Kts} numeric onChange={v => set('vs1Kts', v)} />
      <FieldRow label="Vx" unit="kts" value={form.vxKts} note={pohNotes.vxKts} numeric onChange={v => set('vxKts', v)} />
      <FieldRow label="Vfe" unit="kts" value={form.vfeKts} note={pohNotes.vfeKts} numeric onChange={v => set('vfeKts', v)} />
      <FieldRow label="Va" unit="kts" value={form.vaKts} note={pohNotes.vaKts} numeric onChange={v => set('vaKts', v)} />
      <FieldRow label="Vno" unit="kts" value={form.vnoKts} note={pohNotes.vnoKts} numeric onChange={v => set('vnoKts', v)} />
      <FieldRow label="Vne" unit="kts" value={form.vneKts} note={pohNotes.vneKts} numeric onChange={v => set('vneKts', v)} />

      <SectionLabel text="Equipment" />
      <ChipRow
        label="Transponder"
        options={[{ v: '', label: 'Not set' }, { v: 'none', label: 'None' }, { v: 'A', label: 'A' }, { v: 'C', label: 'C' }, { v: 'S', label: 'S' }]}
        value={form.transponder}
        onChange={v => set('transponder', v as FormState['transponder'])}
      />
      <ChipRow
        label="Radio"
        options={[{ v: '', label: 'Not set' }, { v: 'yes', label: 'Yes' }, { v: 'no', label: 'No' }]}
        value={form.hasRadio}
        onChange={v => set('hasRadio', v as FormState['hasRadio'])}
      />

      {HAS_FUEL(form.category) && (
        <>
          <SectionLabel text="Fuel" />
          <Text style={styles.fieldLabel}>Fuel types, in order of preference (tap to add or remove)</Text>
          <View style={styles.catRow}>
            {form.fuelTypes.map((code, idx) => (
              <View key={code} style={[styles.catChip, styles.catChipActive, styles.fuelChip]}>
                <TouchableOpacity onPress={() => set('fuelTypes', form.fuelTypes.filter(c => c !== code))} accessibilityLabel={`${preferenceLabel(idx)} choice ${FUEL_LABELS[code]}: remove`}>
                  <Text style={[styles.catChipTxt, styles.catChipTxtActive]}>{idx + 1} {FUEL_LABELS[code]}</Text>
                </TouchableOpacity>
                {idx > 0 && (
                  <TouchableOpacity
                    onPress={() => { const next = [...form.fuelTypes]; [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]; set('fuelTypes', next) }}
                    accessibilityLabel={`Prefer ${FUEL_LABELS[code]}`}
                    hitSlop={8}
                  >
                    <Text style={[styles.catChipTxt, styles.catChipTxtActive]}> ↑</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
            {FUEL_CODES.filter(c => !form.fuelTypes.includes(c)).map(code => (
              <TouchableOpacity key={code} style={styles.catChip} onPress={() => set('fuelTypes', normalizeFuelCodes([...form.fuelTypes, code]))}>
                <Text style={styles.catChipTxt}>{FUEL_LABELS[code]}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <FieldRow label="Burn" unit="L/h" value={form.fuelBurnLhr} error={errors.fuelBurnLhr} note={pohNotes.fuelBurnLhr} numeric onChange={v => set('fuelBurnLhr', v)} />
          <FieldRow label="Max capacity" unit="L" value={form.maxFuelL} error={errors.maxFuelL} note={pohNotes.maxFuelL} numeric onChange={v => set('maxFuelL', v)} />
          <FieldRow label="Unusable (not in capacity)" unit="L" value={form.unusableFuelL} note={pohNotes.unusableFuelL} numeric onChange={v => set('unusableFuelL', v)} />
          <FieldRow label="Taxi / T/O" unit="L" value={form.taxiFuelL} note={pohNotes.taxiFuelL} numeric onChange={v => set('taxiFuelL', v)} />
          <FieldRow label="Reserve LDG" unit="L" value={form.landingFuelL} note={pohNotes.landingFuelL} numeric onChange={v => set('landingFuelL', v)} />
          <FieldRow label="Holding" unit="min" value={form.holdingMin} numeric onChange={v => set('holdingMin', v)} />
          <FieldRow label="Diversion" unit="min" value={form.diversionMin} numeric onChange={v => set('diversionMin', v)} />
          <FieldRow label="Final reserve (0 = none)" unit="min" value={form.finalReserveMin} numeric onChange={v => set('finalReserveMin', v)} />
          <FieldRow label="Contingency" unit="%" value={form.contingencyPct} numeric onChange={v => set('contingencyPct', v)} />
        </>
      )}

      {HAS_ENGINE(form.category) && (
        <>
          <SectionLabel text="Climb / Descent" />
          <FieldRow label="Service ceiling" unit="ft" value={form.serviceCeilingFt} note={pohNotes.serviceCeilingFt} numeric onChange={v => set('serviceCeilingFt', v)} />
          <FieldRow label="RoC at SL" unit="fpm" value={form.rocSlFpm} note={pohNotes.rocSlFpm} numeric onChange={v => set('rocSlFpm', v)} />
          <FieldRow label="RoC at ceiling" unit="fpm" value={form.rocCeilingFpm} note={pohNotes.rocCeilingFpm} numeric onChange={v => set('rocCeilingFpm', v)} />
          <FieldRow label="Climb IAS" unit="kts" value={form.climbIas} note={pohNotes.climbIas} numeric onChange={v => set('climbIas', v)} />
          {HAS_FUEL(form.category) && (
            <>
              <FieldRow label="Climb fuel burn" unit="L/h" value={form.climbFuelLhr} note={pohNotes.climbFuelLhr} numeric onChange={v => set('climbFuelLhr', v)} />
              <FieldRow label="Climb burn at ceiling (0 = same)" unit="L/h" value={form.climbFuelCeilingLhr} note={pohNotes.climbFuelCeilingLhr} numeric onChange={v => set('climbFuelCeilingLhr', v)} />
            </>
          )}
          <FieldRow label="Descent rate" unit="fpm" value={form.descentFpm} note={pohNotes.descentFpm} numeric onChange={v => set('descentFpm', v)} />
          <FieldRow label="Descent IAS" unit="kts" value={form.descentIas} note={pohNotes.descentIas} numeric onChange={v => set('descentIas', v)} />
          {HAS_FUEL(form.category) && (
            <FieldRow label="Descent fuel burn" unit="L/h" value={form.descentFuelLhr} note={pohNotes.descentFuelLhr} numeric onChange={v => set('descentFuelLhr', v)} />
          )}
        </>
      )}

      {HAS_GLIDE(form.category) && (
        <>
          <SectionLabel text="Glide" />
          <FieldRow label="Best glide IAS" unit="kts" value={form.bestGlideIas} note={pohNotes.bestGlideIas} numeric onChange={v => set('bestGlideIas', v)} />
          <FieldRow label="Glide ratio" unit=":1" value={form.glideRatio} note={pohNotes.glideRatio} numeric onChange={v => set('glideRatio', v)} />
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

function ChipRow({ label, options, value, onChange }: {
  label: string
  options: { v: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  const styles = useThemedStyles(makeStyles)
  return (
    <>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.catRow} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map(o => (
          <TouchableOpacity
            key={o.v}
            style={[styles.catChip, value === o.v && styles.catChipActive]}
            onPress={() => onChange(o.v)}
            accessibilityRole="radio"
            accessibilityState={{ selected: value === o.v }}
          >
            <Text style={[styles.catChipTxt, value === o.v && styles.catChipTxtActive]}>{o.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </>
  )
}

function SectionLabel({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles)
  return <Text style={styles.sectionLabel}>{text}</Text>
}

function FieldRow({ label, unit, value, error, note, numeric, autoCap, placeholder, onChange }: {
  label: string; unit?: string; value: string; error?: string
  /** Why an imported POH value needs checking. */
  note?: string
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
      {!!note && <Text style={styles.fieldNote}>{note}</Text>}
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
  fieldNote: { color: theme.statusWarn, fontSize: theme.textXs, marginTop: 2 },
  pohToggle: {
    alignItems: 'center', paddingVertical: 8, marginBottom: theme.space2,
    borderRadius: theme.radiusMd, borderWidth: 1, borderColor: theme.borderDefault, borderStyle: 'dashed',
  },
  pohToggleTxt: { color: theme.accentBlue, fontSize: theme.textSm, fontWeight: '600' },
  pohBox: {
    gap: theme.space2, padding: theme.space2, marginBottom: theme.space2,
    borderRadius: theme.radiusMd, borderWidth: 1, borderColor: theme.borderDefault,
  },
  pohStep: { color: theme.textSecondary, fontSize: theme.textXs },
  pohBtn: {
    alignItems: 'center', paddingVertical: 8,
    borderRadius: theme.radiusMd, borderWidth: 1, borderColor: theme.borderDefault,
  },
  pohInput: { minHeight: 90, textAlignVertical: 'top' },
  pohHint: { color: theme.textFaint, fontSize: theme.textXs },
  pohDone: { color: theme.statusOk, fontSize: theme.textXs, marginBottom: theme.space2 },
  btnDisabled: { opacity: 0.5 },
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
  fuelChip: { flexDirection: 'row', alignItems: 'center' },
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
