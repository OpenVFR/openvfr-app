import { useState, useEffect, useRef } from 'react'
import { useAircraftProfiles } from '../db/useAircraftProfiles'
import type { AircraftProfileDocType, AircraftCategory } from '../db/index'
import { extractPohViaServer, RateLimitError } from '../utils/pohExtract'
import { POH_FIELDS, type PohField } from '@open-vfr/shared/pohImport'
import { FUEL_CODES, FUEL_LABELS, normalizeFuelCodes, preferenceLabel } from '@open-vfr/shared/fuelTypes'
import type { FuelCode, TransponderMode } from '@open-vfr/shared/types'
import PohAssistantImport from './PohAssistantImport'
import { useSyncRejected } from '../sync/cloudSync'
import SyncRefusedNote from './SyncRefusedNote'
import css from './AircraftLibrary.module.css'
import { IconCheck, IconX } from '@tabler/icons-react'

// ---------------------------------------------------------------------------
// Category metadata
// ---------------------------------------------------------------------------

const CATEGORIES: { value: AircraftCategory; label: string; badge: string }[] = [
  { value: 'SEP',    label: 'Single Engine Piston',   badge: 'SEP'    },
  { value: 'MEP',    label: 'Multi Engine Piston',    badge: 'MEP'    },
  { value: 'MICRO',  label: 'Microlight / ULM',       badge: 'MICRO'  },
  { value: 'GYRO',   label: 'Gyroplane / Autogyro',   badge: 'GYRO'   },
  { value: 'HELI',   label: 'Helicopter',             badge: 'HELI'   },
  { value: 'TMG',    label: 'Touring Motor Glider',   badge: 'TMG'    },
  { value: 'GLIDER', label: 'Glider / Sailplane',     badge: 'GLIDER' },
]

/** Categories that carry onboard fuel. Gliders have no fuel planning. */
const HAS_FUEL = (cat: AircraftCategory) => cat !== 'GLIDER'
/** Categories with an engine — show Climb / Descent section. */
const HAS_ENGINE = (cat: AircraftCategory) => cat !== 'GLIDER'
/** Categories with meaningful glide performance — show Glide section. */
const HAS_GLIDE = (cat: AircraftCategory) => cat === 'GLIDER' || cat === 'TMG'

// ---------------------------------------------------------------------------
// Form state — all numeric fields as strings for controlled inputs.
// ---------------------------------------------------------------------------

type FormState = {
  name:             string
  registration:     string
  icaoType:         string
  category:         AircraftCategory
  cruiseAltFt:      string
  cruiseIas:        string
  fuelBurnLhr:      string
  maxFuelL:         string
  taxiFuelL:        string
  landingFuelL:     string
  holdingMin:       string
  diversionMin:     string
  contingencyPct:   string
  // Climb / Descent
  serviceCeilingFt: string
  rocSlFpm:         string
  rocCeilingFpm:    string
  climbIas:         string
  climbFuelLhr:     string
  descentFpm:       string
  descentIas:       string
  descentFuelLhr:   string
  // Glide
  bestGlideIas:     string
  glideRatio:       string
  takeoffSpeedKts:  string
  // Fuel grades and runway limits
  fuelTypes:        FuelCode[]
  minRunwayM:       string
  hardRunwayOnly:   boolean
  maxCrosswindKts:  string
  climbFuelCeilingLhr: string
  finalReserveMin:  string
  unusableFuelL:    string
  // Equipment: '' = not set
  transponder:      '' | TransponderMode
  hasRadio:         '' | 'yes' | 'no'
}

const EMPTY_FORM: FormState = {
  name:             '',
  registration:     '',
  icaoType:         '',
  category:         'SEP',
  cruiseAltFt:      '5000',
  cruiseIas:        '100',
  fuelBurnLhr:      '25',
  maxFuelL:         '150',
  taxiFuelL:        '5',
  landingFuelL:     '20',
  holdingMin:       '30',
  diversionMin:     '30',
  contingencyPct:   '10',
  serviceCeilingFt: '14000',
  rocSlFpm:         '700',
  rocCeilingFpm:    '100',
  climbIas:         '80',
  climbFuelLhr:     '30',
  descentFpm:       '500',
  descentIas:       '100',
  descentFuelLhr:   '15',
  bestGlideIas:     '65',
  glideRatio:       '30',
  takeoffSpeedKts:  '0',
  fuelTypes:        [],
  minRunwayM:       '0',
  hardRunwayOnly:   false,
  maxCrosswindKts:  '0',
  climbFuelCeilingLhr: '0',
  finalReserveMin:  '0',
  unusableFuelL:    '0',
  transponder:      '',
  hasRadio:         '',
}

function profileToForm(p: AircraftProfileDocType): FormState {
  return {
    name:             p.name,
    registration:     p.registration,
    icaoType:         p.icaoType,
    category:         p.category ?? 'SEP',
    cruiseAltFt:      String(p.cruiseAltFt),
    cruiseIas:        String(p.cruiseIas),
    fuelBurnLhr:      String(p.fuelBurnLhr),
    maxFuelL:         String(p.maxFuelL),
    taxiFuelL:        String(p.taxiFuelL),
    landingFuelL:     String(p.landingFuelL),
    holdingMin:       String(p.holdingMin),
    diversionMin:     String(p.diversionMin || 30),
    contingencyPct:   String(p.contingencyPct),
    serviceCeilingFt: String(p.serviceCeilingFt ?? 0),
    rocSlFpm:         String(p.rocSlFpm ?? 0),
    rocCeilingFpm:    String(p.rocCeilingFpm ?? 0),
    climbIas:         String(p.climbIas ?? 0),
    climbFuelLhr:     String(p.climbFuelLhr ?? 0),
    descentFpm:       String(p.descentFpm ?? 0),
    descentIas:       String(p.descentIas ?? 0),
    descentFuelLhr:   String(p.descentFuelLhr ?? 0),
    bestGlideIas:     String(p.bestGlideIas ?? 0),
    glideRatio:       String(p.glideRatio ?? 0),
    takeoffSpeedKts:  String(p.takeoffSpeedKts ?? 0),
    fuelTypes:        normalizeFuelCodes(p.fuelTypes),
    minRunwayM:       String(p.minRunwayM ?? 0),
    hardRunwayOnly:   p.hardRunwayOnly === true,
    maxCrosswindKts:  String(p.maxCrosswindKts ?? 0),
    climbFuelCeilingLhr: String(p.climbFuelCeilingLhr ?? 0),
    finalReserveMin:  String(p.finalReserveMin ?? 0),
    unusableFuelL:    String(p.unusableFuelL ?? 0),
    transponder:      p.transponder ?? '',
    hasRadio:         p.hasRadio === true ? 'yes' : p.hasRadio === false ? 'no' : '',
  }
}

function parseNum(s: string, fallback = 0): number {
  const n = parseFloat(s)
  return isNaN(n) ? fallback : n
}

function formErrors(f: FormState): Record<string, string> {
  const e: Record<string, string> = {}
  if (!f.name.trim())                         e.name           = 'Required'
  if (!f.registration.trim())                 e.registration   = 'Required'
  if (parseNum(f.cruiseAltFt) <= 0)           e.cruiseAltFt    = 'Must be > 0'
  if (parseNum(f.cruiseIas)   <= 0)           e.cruiseIas      = 'Must be > 0'
  if (HAS_FUEL(f.category)) {
    if (parseNum(f.fuelBurnLhr) <= 0)         e.fuelBurnLhr    = 'Must be > 0'
    if (parseNum(f.maxFuelL)    <= 0)         e.maxFuelL       = 'Must be > 0'
    if (parseNum(f.contingencyPct) < 0)       e.contingencyPct = 'Must be ≥ 0'
  }
  if (parseNum(f.minRunwayM) < 0)             e.minRunwayM     = 'Must be ≥ 0'
  return e
}

// ---------------------------------------------------------------------------
// Field row helper — label + input in a two-column layout.
// ---------------------------------------------------------------------------

interface FieldProps {
  label:    string
  unit?:    string
  value:    string
  error?:   string
  type?:    string
  placeholder?: string
  tooltip?: string
  /** Set after a POH import when this field needs checking (not found, or looks wrong). */
  pohNote?: string
  /** POH page the imported value came from. */
  pohPage?: string
  onChange: (v: string) => void
}

function Field({ label, unit, value, error, type = 'text', placeholder, tooltip, pohNote, pohPage, onChange }: FieldProps) {
  const base = tooltip ?? label
  const page = pohPage ? ` (POH page ${pohPage})` : ''
  const tip = pohNote ? `${base} — ${pohNote}${page}` : `${base}${page}`
  return (
    <div className={`${css.field}${error ? ` ${css.fieldError}` : ''}${pohNote ? ` ${css.fieldPohMissing}` : ''}`}>
      <label className={css.fieldLabel} title={tip}>
        {label}{unit && <span className={css.fieldUnit}>{unit}</span>}
        {pohNote && <span className={css.pohMissingBadge} title={`${pohNote}${page}`}>?</span>}
      </label>
      <input
        className={css.fieldInput}
        type={type}
        value={value}
        placeholder={placeholder}
        title={tip}
        onChange={e => onChange(e.target.value)}
      />
      {error && <span className={css.fieldErrorMsg}>{error}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AircraftLibrary({
  selectedId,
  onSelect,
}: {
  selectedId?: string
  onSelect?: (id: string | null) => void
}) {
  const { profiles, saveProfile, deleteProfile, duplicateProfile } = useAircraftProfiles()
  const refusedAircraft = useSyncRejected('user_aircraft_profiles')

  // 'list' | 'new' | edit-id
  const [mode,      setMode]      = useState<'list' | 'new' | string>('list')
  const [form,      setForm]      = useState<FormState>(EMPTY_FORM)
  const [errors,    setErrors]    = useState<Record<string, string>>({})
  const [saving,    setSaving]    = useState(false)
  const [deleteId,  setDeleteId]  = useState<string | null>(null)

  // POH import state
  const pohInputRef       = useRef<HTMLInputElement>(null)
  const pohFileRef        = useRef<File | null>(null)
  const pohRetriesRef     = useRef(0)
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [pohState,     setPohState]     = useState<'idle' | 'extracting' | 'querying' | 'done' | 'error' | 'retrying'>('idle')
  const [pohError,     setPohError]     = useState('')
  const [pohCountdown, setPohCountdown] = useState(0)
  const [pohStage,     setPohStage]     = useState('')
  const [pohElapsedSec, setPohElapsedSec] = useState(0)
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Fields from the last POH import that need checking (not found, or a value
  // that looks wrong) — surfaced as a "?" badge next to the field so the user
  // verifies them rather than silently trusting a stale/default value.
  const [pohNotes, setPohNotes] = useState<Map<keyof FormState, string>>(new Map())
  // POH page per imported value, shown in the field's tooltip.
  const [pohPages, setPohPages] = useState<Map<keyof FormState, string>>(new Map())
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantApplied, setAssistantApplied] = useState(false)
  const poh = (key: keyof FormState) => ({ pohNote: pohNotes.get(key), pohPage: pohPages.get(key) })

  // When entering edit mode, populate form from the profile.
  // Also cancel any pending retry countdown when the user navigates away.
  useEffect(() => {
    if (mode === 'list' || mode === 'new') {
      if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null }
      if (elapsedTimerRef.current)   { clearInterval(elapsedTimerRef.current);   elapsedTimerRef.current = null }
      pohFileRef.current = null
      setPohState('idle'); setPohError(''); setPohCountdown(0); setPohStage(''); setPohElapsedSec(0)
      if (mode === 'new') setForm(EMPTY_FORM)
      setErrors({})
      setPohNotes(new Map())
      setPohPages(new Map())
      setAssistantOpen(false)
      setAssistantApplied(false)
      return
    }
    const p = profiles.find(x => x.id === mode)
    if (p) { setForm(profileToForm(p)); setErrors({}) }
  }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps

  function set(key: keyof FormState, val: string) {
    setForm(f => ({ ...f, [key]: val }))
    setErrors(e => { const n = { ...e }; delete n[key]; return n })
    // Manual edit — user has reviewed/overridden this field, clear the badge.
    setPohNotes(m => { if (!m.has(key)) return m; const n = new Map(m); n.delete(key); return n })
  }

  /**
   * Merge imported POH values into the form. Fields without a value keep the
   * user's entry and get a "not found" note; `warnings` mark values to check.
   */
  function applyPohValues(
    values: Partial<Record<PohField, string>>,
    warnings: Partial<Record<PohField, string>> = {},
    pages: Partial<Record<PohField, string>> = {},
    fuelTypes: FuelCode[] = [],
  ) {
    const notes = new Map<keyof FormState, string>()
    const pageMap = new Map<keyof FormState, string>()
    const patch: Partial<FormState> = {}
    for (const key of POH_FIELDS) {
      const v = values[key]
      if (v === undefined) notes.set(key, 'not found in POH, verify manually')
      else {
        patch[key] = v
        if (warnings[key]) notes.set(key, `${warnings[key]}, check against the POH`)
        if (pages[key]) pageMap.set(key, pages[key]!)
      }
    }
    setPohNotes(notes)
    setPohPages(pageMap)
    if (fuelTypes.length > 0) patch.fuelTypes = fuelTypes
    setForm(f => ({ ...f, ...patch }))
  }

  async function runExtraction(file: File) {
    setPohError('')
    setPohStage('Uploading PDF…')
    setPohState('querying')
    setPohElapsedSec(0)
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current)
    elapsedTimerRef.current = setInterval(() => setPohElapsedSec(s => s + 1), 1000)
    try {
      const result = await extractPohViaServer(file, (stage) => {
        if (stage === 'uploading')  setPohStage('Uploading PDF…')
        if (stage === 'processing') setPohStage('Scanning document… (may take 15–45 s)')
        if (stage === 'extracting') setPohStage('Extracting performance data…')
      })
      pohFileRef.current = null
      applyPohValues(result, {}, {}, result.fuelTypes ?? [])
      if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null }
      setPohState('done')
      setTimeout(() => setPohState('idle'), 3000)
    } catch (err) {
      if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null }
      const msg = err instanceof Error ? err.message : 'POH extraction failed.'
      if (err instanceof RateLimitError && pohFileRef.current && err.retryAfterSeconds <= 120 && pohRetriesRef.current < 3) {
        pohRetriesRef.current += 1
        setPohError(msg)
        // Auto-retry after the server-suggested countdown (per-minute limit only;
        // daily exhaustion does not include retryAfterSeconds and falls through
        // to the error state below).
        let secs = err.retryAfterSeconds
        setPohCountdown(secs)
        setPohState('retrying')
        countdownTimerRef.current = setInterval(() => {
          secs -= 1
          setPohCountdown(secs)
          if (secs <= 0) {
            clearInterval(countdownTimerRef.current!)
            countdownTimerRef.current = null
            setPohCountdown(0)
            if (pohFileRef.current) void runExtraction(pohFileRef.current)
          }
        }, 1000)
      } else {
        setPohError(msg)
        setPohState('error')
      }
    }
  }

  async function handlePohFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    pohFileRef.current = file
    pohRetriesRef.current = 0
    await runExtraction(file)
  }

  async function handleSave() {
    const errs = formErrors(form)
    if (Object.keys(errs).length > 0) { setErrors(errs); return }
    setSaving(true)
    try {
      // Keep fields this form does not edit (added by a newer app version) on an existing profile.
      const existing = mode === 'new' ? undefined : profiles.find(p => p.id === mode)
      await saveProfile({
        ...existing,
        id:               mode === 'new' ? undefined : mode,
        name:             form.name.trim(),
        registration:     form.registration.trim().toUpperCase(),
        icaoType:         form.icaoType.trim().toUpperCase(),
        category:         form.category,
        cruiseAltFt:      parseNum(form.cruiseAltFt),
        cruiseIas:        parseNum(form.cruiseIas),
        fuelBurnLhr:      HAS_FUEL(form.category) ? parseNum(form.fuelBurnLhr) : 0,
        maxFuelL:         HAS_FUEL(form.category) ? parseNum(form.maxFuelL)    : 0,
        taxiFuelL:        HAS_FUEL(form.category) ? parseNum(form.taxiFuelL)   : 0,
        landingFuelL:     HAS_FUEL(form.category) ? parseNum(form.landingFuelL): 0,
        holdingMin:       HAS_FUEL(form.category) ? parseNum(form.holdingMin)  : 0,
        diversionMin:     HAS_FUEL(form.category) ? parseNum(form.diversionMin, 30) : 0,
        contingencyPct:   HAS_FUEL(form.category) ? parseNum(form.contingencyPct) : 0,
        serviceCeilingFt: HAS_ENGINE(form.category) ? parseNum(form.serviceCeilingFt) : 0,
        rocSlFpm:         HAS_ENGINE(form.category) ? parseNum(form.rocSlFpm)         : 0,
        rocCeilingFpm:    HAS_ENGINE(form.category) ? parseNum(form.rocCeilingFpm)     : 0,
        climbIas:         HAS_ENGINE(form.category) ? parseNum(form.climbIas)          : 0,
        climbFuelLhr:     HAS_ENGINE(form.category) && HAS_FUEL(form.category) ? parseNum(form.climbFuelLhr) : 0,
        descentFpm:       HAS_ENGINE(form.category) ? parseNum(form.descentFpm)        : 0,
        descentIas:       HAS_ENGINE(form.category) ? parseNum(form.descentIas)        : 0,
        descentFuelLhr:   HAS_ENGINE(form.category) && HAS_FUEL(form.category) ? parseNum(form.descentFuelLhr) : 0,
        bestGlideIas:     HAS_GLIDE(form.category) ? parseNum(form.bestGlideIas) : 0,
        glideRatio:       HAS_GLIDE(form.category) ? parseNum(form.glideRatio)   : 0,
        takeoffSpeedKts:  parseNum(form.takeoffSpeedKts),
        fuelTypes:        HAS_FUEL(form.category) ? form.fuelTypes : [],
        minRunwayM:       Math.max(0, Math.round(parseNum(form.minRunwayM))),
        hardRunwayOnly:   form.hardRunwayOnly,
        maxCrosswindKts:  Math.max(0, parseNum(form.maxCrosswindKts)),
        climbFuelCeilingLhr: HAS_ENGINE(form.category) && HAS_FUEL(form.category) ? Math.max(0, parseNum(form.climbFuelCeilingLhr)) : 0,
        finalReserveMin:  HAS_FUEL(form.category) ? Math.max(0, parseNum(form.finalReserveMin)) : 0,
        unusableFuelL:    HAS_FUEL(form.category) ? Math.max(0, parseNum(form.unusableFuelL)) : 0,
        transponder:      form.transponder || undefined,
        hasRadio:         form.hasRadio === '' ? undefined : form.hasRadio === 'yes',
      })
      setMode('list')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    await deleteProfile(id)
    setDeleteId(null)
    if (mode === id) setMode('list')
  }

  // ── List view ─────────────────────────────────────────────────────────────
  if (mode === 'list') {
    return (
      <div className={css.panel}>
        {profiles.length === 0 ? (
          <p className={css.empty}>No aircraft profiles yet</p>
        ) : (
          <div className={css.list}>
            {profiles.map(p => (
              <div key={p.id} className={css.item}>
                <div className={css.itemInfo}>
                  <span className={css.itemName}>
                    {p.name}
                    <span className={css.categoryBadge}>{p.category ?? 'SEP'}</span>
                  </span>
                  <span className={css.itemMeta}>
                    {p.registration || '—'} · {p.icaoType || '—'} · {p.cruiseIas} kts
                    {HAS_FUEL(p.category ?? 'SEP') && <> · {p.fuelBurnLhr} L/h</>}
                  </span>
                  <SyncRefusedNote row={refusedAircraft.get(p.id)} />
                </div>
                <div className={css.itemActions}>
                  {deleteId === p.id ? (
                    <>
                      <button className={`${css.iconBtn} ${css.iconBtnDanger}`} onClick={() => handleDelete(p.id)} title="Confirm delete"><IconCheck size={14} aria-hidden="true" /></button>
                      <button className={css.iconBtn} onClick={() => setDeleteId(null)} title="Cancel"><IconX size={14} aria-hidden="true" /></button>
                    </>
                  ) : (
                    <>
                      <button
                        className={`${css.iconBtn} ${p.id === selectedId ? css.iconBtnActive : ''}`}
                        title={p.id === selectedId ? 'Active aircraft (click to deselect)' : 'Use this aircraft'}
                        onClick={() => onSelect?.(p.id === selectedId ? null : p.id)}
                      >✈</button>
                      <button className={css.iconBtn} title="Edit" onClick={() => setMode(p.id)}>✎</button>
                      <button className={css.iconBtn} title="Duplicate" onClick={() => duplicateProfile(p.id)}>⎘</button>
                      <button className={`${css.iconBtn} ${css.iconBtnDanger}`} title="Delete" onClick={() => setDeleteId(p.id)}><IconX size={14} aria-hidden="true" /></button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <button className={css.newBtn} onClick={() => setMode('new')}>+ Add Aircraft</button>
      </div>
    )
  }

  // ── Add / Edit form ───────────────────────────────────────────────────────
  const isNew = mode === 'new'
  const pohBusy = pohState === 'extracting' || pohState === 'querying' || pohState === 'retrying'
  return (
    <div className={css.panel}>
      {/* Hidden PDF file input */}
      <input
        ref={pohInputRef}
        type="file"
        accept=".pdf,application/pdf"
        className={css.hiddenInput}
        aria-label="Import POH PDF"
        onChange={handlePohFile}
      />
      <div className={css.formHeader}>
        <span className={css.formTitle}>{isNew ? 'New Aircraft' : 'Edit Aircraft'}</span>
        <div className={css.formHeaderActions}>
          <button
            className={`${css.iconBtn} ${css.pohBtn}${pohBusy ? ` ${css.pohBtnBusy}` : ''}`}
            title="Auto-fill from POH PDF on the server"
            disabled={pohBusy}
            onClick={() => { if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null } setPohState('idle'); setPohError(''); setPohCountdown(0); pohInputRef.current?.click() }}
          >
          {pohState === 'extracting' || pohState === 'querying' ? <span className={css.pohSpinner} /> : pohState === 'retrying' ? '⏱' : pohState === 'done' ? '✓' : '📄'}
          </button>
          <button
            className={`${css.iconBtn}${assistantOpen ? ` ${css.iconBtnActive}` : ''}`}
            title="Fill from POH with your own AI assistant"
            aria-expanded={assistantOpen}
            onClick={() => setAssistantOpen(o => !o)}
          >AI</button>
          <button className={css.iconBtn} title="Back to list" onClick={() => setMode('list')}><IconX size={14} aria-hidden="true" /></button>
        </div>
      </div>

      {assistantOpen && (
        <PohAssistantImport
          onApply={r => {
            applyPohValues(r.values, r.warnings, r.pages, r.fuelTypes)
            setAssistantOpen(false)
            setPohError('')
            setPohState('idle')
            setAssistantApplied(true)
          }}
        />
      )}
      {pohState === 'error' && pohError && (
        <p className={css.pohError}>{pohError}</p>
      )}
      {pohState === 'retrying' && (
        <p className={css.pohRetrying}>{pohError || 'Rate limited.'} Retrying in {pohCountdown}s… (or click ⏱ to pick a new file)</p>
      )}
      {(pohState === 'done' || assistantApplied) && (
        <p className={css.pohSuccess}>
          Fields populated — review and save.
          {pohNotes.size > 0 && ' Fields marked “?” were not found or look wrong — check them against the POH.'}
        </p>
      )}
      {(pohState === 'extracting' || pohState === 'querying') && (
        <p className={css.pohProgress}>
          <span className={css.pohProgressSpinner} />
          {pohStage || 'Uploading PDF…'} ({pohElapsedSec}s)
        </p>
      )}

      <div className={css.form}>
        <div className={css.sectionLabel}>Identity</div>
        <Field label="Name"         value={form.name}         error={errors.name}         placeholder="e.g. My Cessna 172" tooltip="Your name for this aircraft profile" {...poh('name')} onChange={v => set('name', v)} />
        <Field label="Registration" value={form.registration} error={errors.registration} placeholder="SE-ABC"              tooltip="Aircraft registration mark (e.g. SE-ABC)" onChange={v => set('registration', v)} />
        <Field label="ICAO Type"    value={form.icaoType}     placeholder="C172"                                            tooltip="ICAO type designator (e.g. C172, PA28, EC35). Used for wake turbulence category." {...poh('icaoType')} onChange={v => set('icaoType', v)} />

        {/* Category selector */}
        <div className={css.field}>
          <label className={css.fieldLabel}>Category</label>
          <select
            className={css.fieldSelect}
            value={form.category}
            title="Aircraft category"
            onChange={e => set('category', e.target.value as AircraftCategory)}
          >
            {CATEGORIES.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>

        <div className={css.sectionLabel}>Performance</div>
        <Field label="Cruise Alt"   unit="ft"  type="number" value={form.cruiseAltFt}  error={errors.cruiseAltFt}  tooltip="Typical cruising altitude in feet MSL. Used for airspace checks and flight profile projection." {...poh('cruiseAltFt')} onChange={v => set('cruiseAltFt', v)} />
        <Field label="Cruise IAS"   unit="kts" type="number" value={form.cruiseIas}    error={errors.cruiseIas}    tooltip="Typical cruise indicated airspeed in knots. Used to calculate leg times and fuel burn." {...poh('cruiseIas')} onChange={v => set('cruiseIas', v)} />
        <Field label="Takeoff speed" unit="kts" type="number" value={form.takeoffSpeedKts} {...poh('takeoffSpeedKts')} tooltip="Ground speed at which this aircraft takes off, in knots. Used to detect takeoff and landing for auto flying mode and the flight log. 0 = default for the aircraft category." onChange={v => set('takeoffSpeedKts', v)} />

        <div className={css.sectionLabel}>Runway</div>
        <Field label="Min runway" unit="m" type="number" value={form.minRunwayM} error={errors.minRunwayM} tooltip="Shortest runway you accept for this aircraft, in metres. Used when suggesting fuel stops and destinations. 0 = no limit." onChange={v => set('minRunwayM', v)} />
        <Field label="Max crosswind" unit="kts" type="number" value={form.maxCrosswindKts} tooltip="Maximum demonstrated crosswind in knots. The pre-flight check compares it with the reported wind at departure, destination and fuel stops. 0 = not set." {...poh('maxCrosswindKts')} onChange={v => set('maxCrosswindKts', v)} />
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="ac-hard-rwy" title="Only suggest aerodromes with an asphalt or concrete runway.">Paved only</label>
          <input
            id="ac-hard-rwy"
            type="checkbox"
            className={css.fieldCheck}
            checked={form.hardRunwayOnly}
            onChange={e => setForm(f => ({ ...f, hardRunwayOnly: e.target.checked }))}
          />
        </div>

        <div className={css.sectionLabel}>Equipment</div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="ac-xpdr" title="Transponder fitted. Without one the pre-flight check treats a TMZ on the route as a hard stop.">Transponder</label>
          <select id="ac-xpdr" className={css.fieldSelect} value={form.transponder}
            onChange={e => setForm(f => ({ ...f, transponder: e.target.value as FormState['transponder'] }))}>
            <option value="">Not set</option>
            <option value="none">None</option>
            <option value="A">Mode A</option>
            <option value="C">Mode C</option>
            <option value="S">Mode S</option>
          </select>
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="ac-radio" title="VHF radio fitted. Without one the pre-flight check treats an RMZ or controlled airspace (class A to D) on the route as a hard stop.">Radio</label>
          <select id="ac-radio" className={css.fieldSelect} value={form.hasRadio}
            onChange={e => setForm(f => ({ ...f, hasRadio: e.target.value as FormState['hasRadio'] }))}>
            <option value="">Not set</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>

        {HAS_FUEL(form.category) && (
          <>
            <div className={css.sectionLabel}>Fuel</div>
            <div className={css.field}>
              <span className={css.fieldLabel} title="Fuel grades the engine is approved for, in order of preference: the first is the one you prefer. Used to find aerodromes that sell a suitable fuel; fuel stops with your preferred fuel rank higher.">Fuel types</span>
              <div className={css.chips} role="group" aria-label="Fuel types, in order of preference">
                {form.fuelTypes.map((code, idx) => (
                  <span key={code} className={`${css.chip} ${css.chipActive} ${css.chipRanked}`}>
                    <button
                      type="button"
                      className={css.chipMain}
                      aria-pressed={true}
                      title={`${preferenceLabel(idx)} choice. Click to remove.`}
                      onClick={() => setForm(f => ({ ...f, fuelTypes: f.fuelTypes.filter(c => c !== code) }))}
                    ><span className={css.chipRank}>{idx + 1}</span>{FUEL_LABELS[code]}</button>
                    {idx > 0 && (
                      <button
                        type="button"
                        className={css.chipUp}
                        aria-label={`Prefer ${FUEL_LABELS[code]} over ${FUEL_LABELS[form.fuelTypes[idx - 1]]}`}
                        title="Move up (more preferred)"
                        onClick={() => setForm(f => {
                          const next = [...f.fuelTypes]
                          ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
                          return { ...f, fuelTypes: next }
                        })}
                      >↑</button>
                    )}
                  </span>
                ))}
                {FUEL_CODES.filter(code => !form.fuelTypes.includes(code)).map(code => (
                  <button
                    key={code}
                    type="button"
                    className={css.chip}
                    aria-pressed={false}
                    title="Add as an approved fuel (after the ones already chosen)"
                    onClick={() => setForm(f => ({ ...f, fuelTypes: normalizeFuelCodes([...f.fuelTypes, code]) }))}
                  >{FUEL_LABELS[code]}</button>
                ))}
              </div>
            </div>
            <Field label="Burn"         unit="L/h" type="number" value={form.fuelBurnLhr}  error={errors.fuelBurnLhr}  tooltip="Cruise fuel consumption in litres per hour." {...poh('fuelBurnLhr')} onChange={v => set('fuelBurnLhr', v)} />
            <Field label="Max capacity" unit="L"   type="number" value={form.maxFuelL}     error={errors.maxFuelL}     tooltip="Total usable fuel capacity in litres." {...poh('maxFuelL')} onChange={v => set('maxFuelL', v)} />
            <Field label="Unusable"     unit="L"   type="number" value={form.unusableFuelL} tooltip="Unusable fuel in litres, not part of the usable capacity above. Shown in the fuel plan for reference. 0 = not set." {...poh('unusableFuelL')} onChange={v => set('unusableFuelL', v)} />
            <Field label="Taxi / T/O"   unit="L"   type="number" value={form.taxiFuelL}    tooltip="Fuel used for engine start, taxi and take-off roll. Deducted before departure fuel is calculated." {...poh('taxiFuelL')} onChange={v => set('taxiFuelL', v)} />
            <Field label="Reserve LDG"  unit="L"   type="number" value={form.landingFuelL} tooltip="Fixed landing fuel reserve in litres. Always kept in reserve and never used in fuel planning." {...poh('landingFuelL')} onChange={v => set('landingFuelL', v)} />
            <Field label="Holding"      unit="min" type="number" value={form.holdingMin}   tooltip="Extra holding allowance in minutes, burned at cruise fuel rate. Added on top of trip fuel." onChange={v => set('holdingMin', v)} />
            <Field label="Diversion"    unit="min" type="number" value={form.diversionMin} tooltip="Diversion reserve in minutes, burned at cruise fuel rate (default 30)." onChange={v => set('diversionMin', v)} />
            <Field label="Final reserve" unit="min" type="number" value={form.finalReserveMin} tooltip="Final reserve in minutes at cruise burn, added on top of the other reserves (for example 30 min day VFR). 0 = none." onChange={v => set('finalReserveMin', v)} />
            <Field label="Contingency"  unit="%"   type="number" value={form.contingencyPct} error={errors.contingencyPct} tooltip="Extra fuel as a percentage of trip fuel (e.g. 5 for 5%). EU OPS minimum is 5%." onChange={v => set('contingencyPct', v)} />
          </>
        )}

        {HAS_ENGINE(form.category) && (
          <>
            <div className={css.sectionLabel}>Climb / Descent</div>
            <Field label="Service ceiling" unit="ft"  type="number" value={form.serviceCeilingFt} tooltip="Maximum altitude where the aircraft can sustain at least 100 fpm rate of climb." {...poh('serviceCeilingFt')} onChange={v => set('serviceCeilingFt', v)} />
            <Field label="RoC at SL"       unit="fpm" type="number" value={form.rocSlFpm}         tooltip="Best rate of climb (Vy) at sea level in feet per minute. Used to project climb performance." {...poh('rocSlFpm')} onChange={v => set('rocSlFpm', v)} />
            <Field label="RoC at ceiling"  unit="fpm" type="number" value={form.rocCeilingFpm}    tooltip="Rate of climb just below the service ceiling, typically 50–100 fpm. Used to interpolate climb performance at altitude." {...poh('rocCeilingFpm')} onChange={v => set('rocCeilingFpm', v)} />
            <Field label="Climb IAS"       unit="kts" type="number" value={form.climbIas}         tooltip="Best rate of climb speed (Vy) in knots IAS." {...poh('climbIas')} onChange={v => set('climbIas', v)} />
            {HAS_FUEL(form.category) && (
              <>
                <Field label="Climb fuel burn" unit="L/h" type="number" value={form.climbFuelLhr} tooltip="Fuel consumption during climb at sea level in litres per hour." {...poh('climbFuelLhr')} onChange={v => set('climbFuelLhr', v)} />
                <Field label="Climb burn at ceiling" unit="L/h" type="number" value={form.climbFuelCeilingLhr} tooltip="Fuel consumption during climb near the service ceiling in litres per hour. Climb burn is scaled between the two with altitude. 0 = same as at sea level." {...poh('climbFuelCeilingLhr')} onChange={v => set('climbFuelCeilingLhr', v)} />
              </>
            )}
            <Field label="Descent rate" unit="fpm" type="number" value={form.descentFpm}      tooltip="Typical descent rate in feet per minute (enter as a positive number, e.g. 500)." {...poh('descentFpm')} onChange={v => set('descentFpm', v)} />
            <Field label="Descent IAS"  unit="kts" type="number" value={form.descentIas}      tooltip="Typical descent indicated airspeed in knots." {...poh('descentIas')} onChange={v => set('descentIas', v)} />
            {HAS_FUEL(form.category) && (
              <Field label="Descent fuel burn" unit="L/h" type="number" value={form.descentFuelLhr} tooltip="Fuel consumption during descent in litres per hour." {...poh('descentFuelLhr')} onChange={v => set('descentFuelLhr', v)} />
            )}
          </>
        )}

        {HAS_GLIDE(form.category) && (
          <>
            <div className={css.sectionLabel}>Glide</div>
            <Field label="Best glide IAS" unit="kts" type="number" value={form.bestGlideIas} tooltip="Best glide speed in knots IAS — the speed that maximises glide distance (min sink / max L/D)." {...poh('bestGlideIas')} onChange={v => set('bestGlideIas', v)} />
            <Field label="Glide ratio"    unit=":1"  type="number" value={form.glideRatio}   tooltip="Best glide ratio, e.g. 30 for 30:1 (30 metres forward per 1 metre of altitude lost)." {...poh('glideRatio')} onChange={v => set('glideRatio', v)} />
          </>
        )}
      </div>

      <div className={css.formActions}>
        <button className={css.btn} onClick={() => setMode('list')} disabled={saving}>Cancel</button>
        <button className={`${css.btn} ${css.btnPrimary}`} onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : isNew ? 'Add' : 'Save'}
        </button>
      </div>
    </div>
  )
}
