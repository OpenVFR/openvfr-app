/**
 * Local information of an aerodrome (experimental): circuits per runway, local
 * rules, hours, areas, holding points with their orbit, reporting points -- each with every source it came from and
 * an "unreviewed" mark in preview data. Same content as web's LocalInfoSection.tsx.
 */
import React, { useEffect, useState } from 'react'
import { Linking, Text, TouchableOpacity, View, StyleSheet } from 'react-native'
import {
  DETAIL_KIND_COLOR, DETAIL_KIND_LABEL, formatLimits, hasLocalInfo, orbitLabel, unstatedCircuitEnds, unstatedCircuitNote, circuitEndGroups, circuitNotes, parseAerodromeDetails,
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
      <Text style={styles.source}>Source:</Text>
      {list.map((q, i) => q.source_name && (
        <Text key={i} style={[styles.source, q.source_url ? styles.link : null]}
          onPress={q.source_url ? () => { void Linking.openURL(q.source_url!) } : undefined}>
          {i > 0 ? '· ' : ''}{q.source_name}
        </Text>
      ))}
    </View>
  )
}

/** A block of the section; `count` makes it an expander (closed to start with unless it is short (3 lines or fewer): the heading says how many lines are inside). */
function Block({ title, prov, children, styles, count, preview }:
  { title: string; prov?: DetailProvenance; children: React.ReactNode; styles: ReturnType<typeof makeStyles>; count?: number; preview?: React.ReactNode }) {
  const [open, setOpen] = useState(count === undefined || count <= 3)
  const head = (
    <View style={styles.blockHead}>
      {count !== undefined && <Text style={styles.chevron}>{open ? '\u25BE' : '\u25B8'}</Text>}
      <Text style={styles.blockTitle}>{title.toUpperCase()}</Text>
      {count !== undefined && <Text style={styles.count}>{count}</Text>}
      {prov?.review === 'pending' && <Text style={styles.pending}>UNREVIEWED</Text>}
    </View>
  )
  return (
    <View style={styles.block}>
      {count === undefined ? head : (
        <TouchableOpacity onPress={() => setOpen(o => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }}
          accessibilityLabel={`${title}, ${count} lines, ${open ? 'collapse' : 'expand'}`} style={styles.toggle}>
          {head}
        </TouchableOpacity>
      )}
      {open ? <>{children}<Sources p={prov} styles={styles} /></> : preview}
    </View>
  )
}

/** Rules under headings; `onlyKey` keeps just the lines marked key (the preview while the block is closed). */
function RuleGroups({ groups, onlyKey, styles }: { groups: RuleGroup[]; onlyKey?: boolean; styles: ReturnType<typeof makeStyles> }) {
  return (
    <>
      {groups.map(g => {
        const shown = onlyKey ? g.lines.filter(l => l.key) : g.lines
        if (!shown.length) return null
        return (
          <View key={g.id} style={styles.ruleGroup}>
            <Text style={styles.ruleGroupTitle}>{g.title}</Text>
            {shown.map((l, i) => <Text key={i} style={[styles.item, l.key && styles.keyRule]}>{l.text}</Text>)}
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
          {circuitEndGroups(info.circuits).summary && <Text style={styles.height}>{circuitEndGroups(info.circuits).summary}</Text>}
          {circuitEndGroups(info.circuits).ends.map((e, k) => (
            <View key={e.runway} style={[styles.end, k > 0 && styles.endSep]} accessible accessibilityLabel={`Runway ${e.runway}: ${e.entries.map(x => x.text).join('; ')}`}>
              <View style={styles.rwy}><Text style={styles.rwyText}>{e.runway}</Text></View>
              <View style={styles.entries}>
                {e.entries.map((x, i) => (
                  <View key={i} style={styles.entry}>
                    <Text style={styles.hand}>{x.hand}</Text>
                    {x.who && <Text style={styles.who}>{x.who}</Text>}
                    {x.height && <Text style={styles.who}>{x.height}</Text>}
                  </View>
                ))}
              </View>
            </View>
          ))}
          {notes.map(n => <Text key={n} style={styles.note2}>{'\u2022  '}{n}</Text>)}
          {unstatedCircuitEnds(info).length > 0 && <Text style={styles.sub}>{unstatedCircuitNote(unstatedCircuitEnds(info))}</Text>}
          <Text style={styles.sub}>Shown on the map when zoomed in.</Text>
        </Block>
      )}
      {info.localRules.length > 0 && (
        <Block title="Local rules" prov={pv['local_rules']} styles={styles} count={info.localRules.length}
          preview={info.localRuleGroups ? <RuleGroups groups={info.localRuleGroups} onlyKey styles={styles} /> : undefined}>
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
    block: { paddingTop: theme.space2, paddingBottom: theme.space1, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.borderSubtle },
    blockHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space1, marginBottom: theme.space1 },
    toggle: { minHeight: 44, justifyContent: 'center' },
    chevron: { color: theme.textMuted, fontSize: theme.textSm, width: 14 },
    count: { color: theme.textSecondary, fontSize: theme.textXs, fontWeight: '700', backgroundColor: theme.surfaceHover, borderRadius: theme.radiusFull, paddingHorizontal: 6, minWidth: 18, textAlign: 'center' },
    blockTitle: { color: theme.textMuted, fontSize: theme.textXs, letterSpacing: 0.8, fontWeight: '600' },
    sources: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: theme.space1 },
    height: { color: theme.textPrimary, fontSize: theme.textSm, marginBottom: theme.space1 },
    end: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space2, paddingVertical: theme.space1 },
    endSep: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.borderSubtle },
    rwy: { minWidth: 40, alignItems: 'center', paddingVertical: 3, paddingHorizontal: 8, borderWidth: 1, borderColor: theme.textMuted, borderRadius: 8 },
    rwyText: { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '700' },
    entries: { flex: 1, gap: 6 },
    entry: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 10 },
    hand: { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '600' },
    who: { color: theme.textMuted, fontSize: theme.textSm },
    note2: { color: theme.textMuted, fontSize: theme.textXs, lineHeight: 18, marginTop: 4, paddingLeft: 4 },
    source: { color: theme.textMuted, fontSize: theme.textXs },
    link: { textDecorationLine: 'underline' },
    pending: { color: '#f59e0b', fontSize: theme.textXs, borderWidth: 1, borderColor: '#f59e0b', borderRadius: 3, paddingHorizontal: 3 },
    item: { color: theme.textPrimary, fontSize: theme.textSm, lineHeight: 20, marginVertical: 3 },
    ruleGroup: { marginBottom: theme.space1 },
    ruleGroupTitle: { color: theme.textMuted, fontSize: theme.textXs, fontWeight: '600', marginTop: 2 },
    keyRule: { fontWeight: '600' },
    sub: { color: theme.textMuted, fontSize: theme.textXs, lineHeight: 18, marginTop: 4 },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space1 },
    swatch: { width: 8, height: 8, borderRadius: 2, marginTop: 5 },
    note: { color: theme.textMuted, fontSize: theme.textXs, fontStyle: 'italic' },
  })
}
