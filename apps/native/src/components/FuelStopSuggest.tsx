/**
 * "Suggest fuel stop" in the plan's fuel card when the fuel is short: runs
 * the shared fuel-stop search over the aerodrome data and inserts a chosen
 * plan's stops as fuel stops (one edit). Nothing runs until the pilot asks.
 * Native counterpart of web's FuelStopSuggest.tsx.
 */
import React, { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native'
import { parseAerodromesGeoJson, type AerodromeEntry } from '@open-vfr/shared/findDestination'
import { suggestFuelStops, insertFuelStops, type FuelStopResult } from '@open-vfr/shared/fuelStops'
import { FUEL_LABELS, preferenceLabel } from '@open-vfr/shared/fuelTypes'
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'
import type { LegOverride } from '@open-vfr/shared/types'
import type { AircraftProfileDocType } from '../db'
import { getTileUrls } from '../config'
import { fetchWithRetry } from '@open-vfr/shared/fetchWithRetry'
import { onActiveCountriesChange } from '@open-vfr/shared/countryData'
import { theme, useThemedStyles, type ScaledTheme } from '../styles/theme'

// One parse of the aerodrome file per app session, shared by every mount.
let aerodromesPromise: Promise<AerodromeEntry[]> | null = null
// The files are per country: another active country starts a fresh load.
onActiveCountriesChange(() => { aerodromesPromise = null })
function loadAerodromes(): Promise<AerodromeEntry[]> {
  if (!aerodromesPromise) {
    const p = fetchWithRetry(getTileUrls().aerodromes)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Aerodrome data: HTTP ${r.status}`)
        return parseAerodromesGeoJson(await r.json())
      })
    aerodromesPromise = p
    p.catch(() => { if (aerodromesPromise === p) aerodromesPromise = null })
  }
  return aerodromesPromise
}

function fmtTime(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}` : `${m} min`
}

interface Props {
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraft:     AircraftProfileDocType
  legWinds:     ({ dirDeg: number; speedKts: number } | null)[]
  /** Replace the route's points and leg overrides in one edit. */
  onApply:      (waypoints: RouteWaypoint[], legOverrides: LegOverride[]) => void
}

export function FuelStopSuggest({ waypoints, legOverrides, aircraft, legWinds, onApply }: Props) {
  const styles = useThemedStyles(makeStyles)
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<FuelStopResult | null>(null)

  // A route or aircraft change makes the suggestions stale.
  useEffect(() => { setResult(null); setState('idle') }, [waypoints, legOverrides, aircraft])

  async function run() {
    setState('busy')
    try {
      const aerodromes = await loadAerodromes()
      setResult(suggestFuelStops(waypoints, legOverrides, aircraft, aerodromes, legWinds))
      setState('done')
    } catch {
      setState('error')
    }
  }

  if (state !== 'done' || !result) {
    return (
      <View style={styles.box}>
        <TouchableOpacity style={styles.btn} disabled={state === 'busy'} onPress={run} testID="suggest-fuel-stop">
          {state === 'busy'
            ? <ActivityIndicator size="small" color={theme.accentBlue} />
            : <Text style={styles.btnTxt}>Suggest fuel stop</Text>}
        </TouchableOpacity>
        {state === 'error' && <Text style={styles.error}>Could not load aerodrome data. Try again.</Text>}
      </View>
    )
  }

  return (
    <View style={styles.box}>
      {result.status === 'not-needed' && <Text style={styles.note}>No fuel stop needed.</Text>}
      {result.status === 'missing-profile-data' && (
        <Text style={styles.note}>Set cruise speed, fuel burn and usable fuel in the aircraft profile first.</Text>
      )}
      {result.status === 'none-found' && (
        <Text style={styles.note}>
          No aerodrome near the route fits: {result.candidates === 0
            ? 'none sells a matching fuel with an acceptable runway within 25 NM of the route.'
            : 'none splits the route into hops the tanks can cover.'} Check the aircraft's fuel types and runway limits, or add a stop by hand.
        </Text>
      )}
      {result.status === 'found' && (
        <>
          {result.fuelTypesUnset && (
            <Text style={styles.note}>The aircraft has no fuel types set: these aerodromes list some fuel, not necessarily yours.</Text>
          )}
          {result.plans.map((plan, i) => (
            <View key={i} style={styles.plan}>
              {plan.stops.map(s => (
                <View key={s.aerodrome.icao}>
                  <Text style={styles.stopTitle}>
                    <Text style={styles.icao}>{s.aerodrome.icao}</Text> {s.aerodrome.name}
                  </Text>
                  <Text style={styles.meta}>
                    {s.fuels.length > 0 ? s.fuels.map(f => FUEL_LABELS[f]).join(', ') : s.aerodrome.fuel.join(', ')}
                    {s.fuels.length > 0 && s.fuelRank > 0 ? ` (${preferenceLabel(s.fuelRank)} choice)` : ''}
                    {' · '}{s.aerodrome.maxRunwayM > 0 ? `${s.aerodrome.maxRunwayM} m` : 'runway ?'}
                    {s.aerodrome.surfaces.length > 0 ? ` ${s.aerodrome.surfaces.join('/')}` : ''}
                    {' · '}{s.detourNm < 1 ? 'on track' : `+${s.detourNm.toFixed(0)} NM`}
                    {s.aerodrome.ppr ? ' · PPR' : ''}
                  </Text>
                </View>
              ))}
              {plan.hops.map((h, k) => (
                <Text key={k} style={styles.hop}>{h.from}→{h.to} {fmtTime(h.enrouteMins)}, {h.landingFuelL.toFixed(0)} L left</Text>
              ))}
              <View style={styles.planFoot}>
                <Text style={styles.meta}>{plan.stops.length} stop{plan.stops.length > 1 ? 's' : ''} · +{Math.round(plan.extraMins)} min flying</Text>
                <TouchableOpacity
                  style={styles.btnSmall}
                  onPress={() => {
                    const next = insertFuelStops(waypoints, legOverrides, plan)
                    onApply(next.waypoints, next.legOverrides)
                  }}
                >
                  <Text style={styles.btnTxt}>Add to route</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
          <Text style={styles.caveat}>Fuel listings come from published aerodrome data and can be out of date. Check the AIP, opening hours and NOTAMs, or call ahead.</Text>
        </>
      )}
      <TouchableOpacity onPress={() => { setResult(null); setState('idle') }} style={styles.closeBtn}>
        <Text style={styles.close}>Close</Text>
      </TouchableOpacity>
    </View>
  )
}

function makeStyles(theme: ScaledTheme) {
  return {
    box: { marginTop: theme.space2, gap: theme.space2 },
    btn: {
      alignSelf: 'flex-start', paddingVertical: 7, paddingHorizontal: theme.space3,
      borderRadius: theme.radiusMd, borderWidth: 1, borderColor: theme.accentBlue,
    },
    btnSmall: {
      paddingVertical: 4, paddingHorizontal: theme.space2,
      borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.accentBlue,
    },
    btnTxt: { color: theme.accentBlue, fontSize: theme.textSm, fontWeight: '600' },
    error: { color: theme.statusDanger, fontSize: theme.textXs },
    note: { color: theme.textMuted, fontSize: theme.textXs },
    caveat: { color: theme.textFaint, fontSize: theme.textXs },
    plan: {
      gap: 2, padding: theme.space2,
      borderRadius: theme.radiusSm, borderWidth: 1, borderColor: theme.borderDefault,
    },
    stopTitle: { color: theme.textPrimary, fontSize: theme.textSm },
    icao: { color: theme.accentBlue, fontWeight: '700' },
    meta: { color: theme.textMuted, fontSize: theme.textXs },
    hop: { color: theme.textFaint, fontSize: theme.textXs },
    planFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },
    closeBtn: { alignSelf: 'flex-end' },
    close: { color: theme.textFaint, fontSize: theme.textXs },
  } as const
}
