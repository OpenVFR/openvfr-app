/**
 * Local information of an aerodrome (experimental): circuits per runway, local
 * rules, hours, areas, holding points with their orbit, reporting points -- each with every source it came from and
 * an "unreviewed" mark in preview data. Same content as web's LocalInfoSection.tsx.
 */
import React, { useEffect, useState } from 'react'
import { Linking, Text, TouchableOpacity, View, StyleSheet } from 'react-native'
import {
  DETAIL_KIND_COLOR, DETAIL_KIND_LABEL, formatCircuit, formatLimits, hasLocalInfo, orbitLabel, unstatedCircuitEnds, unstatedCircuitNote, circuitEndGroups, circuitNotes, parseAerodromeDetails,
  type DetailProvenance, type LocalInfo, type RuleGroup,
} from '@open-vfr/shared/aerodromeDetails'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'
import { Section } from './AerodromeBriefShared'
import { loadAssetJson } from '../utils/offlineCache'

function Sources({ p, styles }: { p?: DetailProvenance; styles: ReturnType<typeof makeStyles> }) {
  if (!p) return null
  const list = p.sources?.length ? p.sources : [p]
  return (
    <View style={styles.sources}>
      {p.review === 'pending' && <Text style={styles.pending}>UNREVIEWED</Text>}
      {list.map((q, i) => q.source_name && (
        <Text key={i} style={[styles.source, q.source_url ? styles.link : null]}
          onPress={q.source_url ? () => { void Linking.openURL(q.source_url!) } : undefined}>
          {i > 0 ? '· ' : ''}{q.source_name}
        </Text>
      ))}
    </View>
  )
}

function Block({ title, prov, children, styles }:
  { title: string; prov?: DetailProvenance; children: React.ReactNode; styles: ReturnType<typeof makeStyles> }) {
  return (
    <View style={styles.block}>
      <View style={styles.blockHead}>
        <Text style={styles.blockTitle}>{title.toUpperCase()}</Text>
        <Sources p={prov} styles={styles} />
      </View>
      {children}
    </View>
  )
}

/** Rules under headings: the key lines show, the rest fold away under their heading. */
function RuleGroups({ groups, styles }: { groups: RuleGroup[]; styles: ReturnType<typeof makeStyles> }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  return (
    <>
      {groups.map(g => {
        const key = g.lines.filter(l => l.key), rest = g.lines.filter(l => !l.key)
        const fold = rest.length >= 2          // a single line is not worth a toggle
        const shown = open[g.id] || !fold ? g.lines : key
        return (
          <View key={g.id} style={styles.ruleGroup}>
            <Text style={styles.ruleGroupTitle}>{g.title}</Text>
            {shown.map((l, i) => <Text key={i} style={[styles.item, l.key && styles.keyRule]}>{l.text}</Text>)}
            {fold && (
              <TouchableOpacity onPress={() => setOpen(o => ({ ...o, [g.id]: !o[g.id] }))} accessibilityRole="button"
                accessibilityState={{ expanded: !!open[g.id] }} accessibilityLabel={`${g.title}: ${open[g.id] ? 'show less' : 'show all'}`}>
                <Text style={styles.more}>{open[g.id] ? 'Show less' : key.length ? `${rest.length} more` : `Show ${rest.length}`}</Text>
              </TouchableOpacity>
            )}
          </View>
        )
      })}
    </>
  )
}

export default function LocalInfoSection({ info, icao }: { info: LocalInfo | undefined; icao?: string }) {
  const styles = useThemedStyles(makeStyles)
  const [notes, setNotes] = useState<string[]>([])
  useEffect(() => {
    setNotes([])
    if (!icao) return
    let cancelled = false
    loadAssetJson('aerodromeDetails')
      .then(j => { if (!cancelled) setNotes(circuitNotes(parseAerodromeDetails(j)?.features ?? [], icao)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [icao])
  if (!info || !hasLocalInfo(info)) return null
  const pv = info.provenance
  const lines = (xs: string[]) => xs.map((x, i) => <Text key={i} style={styles.item}>{x}</Text>)
  return (
    <Section title="Local information">
      {info.circuits.length > 0 && (
        <Block title="Circuits" prov={pv['circuits']} styles={styles}>
          {circuitEndGroups(info.circuits).ends.map(e => <Text key={e.runway} style={styles.item}>RWY {e.runway}  {e.entries.map(x => x.text).join('; ')}</Text>)}
          {circuitEndGroups(info.circuits).summary && <Text style={styles.sub}>{circuitEndGroups(info.circuits).summary}</Text>}
          {notes.map(n => <Text key={n} style={styles.sub}>{n}</Text>)}
          {unstatedCircuitEnds(info).length > 0 && <Text style={styles.sub}>{unstatedCircuitNote(unstatedCircuitEnds(info))}</Text>}
          <Text style={styles.sub}>Shown on the map when zoomed in.</Text>
        </Block>
      )}
      {info.localRules.length > 0 && (
        <Block title="Local rules" prov={pv['local_rules']} styles={styles}>
          {info.localRuleGroups ? <RuleGroups groups={info.localRuleGroups} styles={styles} /> : lines(info.localRules)}
        </Block>
      )}
      {info.hoursRemarks.length > 0 && <Block title="Hours" prov={pv['hours_remarks']} styles={styles}>{lines(info.hoursRemarks)}</Block>}
      {info.areas.length > 0 && (
        <Block title="Areas" prov={pv['areas']} styles={styles}>
          {info.areas.map((a, i) => (
            <View key={i} style={styles.row}>
              <View style={[styles.swatch, { backgroundColor: DETAIL_KIND_COLOR[a.kind] }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.item}>
                  {a.name ?? DETAIL_KIND_LABEL[a.kind]}{formatLimits(a.floor, a.ceiling) ? `  ${formatLimits(a.floor, a.ceiling)}` : ''}
                </Text>
                {a.remark && <Text style={styles.sub}>{a.remark}</Text>}
              </View>
            </View>
          ))}
        </Block>
      )}
      {info.holdings.length > 0 && (
        <Block title="Holding points" prov={pv['holdings']} styles={styles}>
          {info.holdings.map(h => (
            <View key={h.name}>
              <Text style={styles.item}>HOLD {h.name}{h.direction ? ` · ${orbitLabel(h.direction)}` : ''}</Text>
              {h.description && <Text style={styles.sub}>{h.description}</Text>}
            </View>
          ))}
        </Block>
      )}
      {info.reportingPoints.length > 0 && (
        <Block title="Reporting points" prov={pv['reporting_points']} styles={styles}>
          <Text style={styles.item}>{info.reportingPoints.map(p => p.name).join(' · ')}</Text>
        </Block>
      )}
      <Text style={styles.note}>Always check the official publication.</Text>
    </Section>
  )
}

function makeStyles(theme: ScaledTheme) {
  return StyleSheet.create({
    block: { marginBottom: theme.space2 },
    blockHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.space1, marginBottom: 2 },
    blockTitle: { color: theme.textMuted, fontSize: theme.textXs, letterSpacing: 0.6 },
    sources: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 4, flexShrink: 1 },
    source: { color: theme.textMuted, fontSize: theme.textXs },
    link: { textDecorationLine: 'underline' },
    pending: { color: '#f59e0b', fontSize: theme.textXs, borderWidth: 1, borderColor: '#f59e0b', borderRadius: 3, paddingHorizontal: 3 },
    item: { color: theme.textPrimary, fontSize: theme.textSm, marginVertical: 1 },
    ruleGroup: { marginBottom: theme.space1 },
    ruleGroupTitle: { color: theme.textMuted, fontSize: theme.textXs, fontWeight: '600', marginTop: 2 },
    keyRule: { fontWeight: '600' },
    more: { color: theme.textMuted, fontSize: theme.textXs, textDecorationLine: 'underline', paddingVertical: 4 },
    sub: { color: theme.textMuted, fontSize: theme.textXs, marginLeft: theme.space2 },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space1 },
    swatch: { width: 8, height: 8, borderRadius: 2, marginTop: 5 },
    note: { color: theme.textMuted, fontSize: theme.textXs, fontStyle: 'italic' },
  })
}
