/**
 * "Local information" section of the aerodrome popup (experimental): circuits per runway (and aircraft
 * category), local rules, hours and PPR remarks, local areas with their
 * heights and reporting points, each with its source. Values marked
 * unreviewed exist only in a local preview build. Renders nothing when the
 * aerodrome has no such fields.
 */
import { useState } from 'react'
import {
  DETAIL_KIND_COLOR, DETAIL_KIND_LABEL, formatCircuit, formatLimits, hasLocalInfo, orbitLabel, type DetailProvenance,
  type LocalInfo, type RuleGroup,
} from '@open-vfr/shared/aerodromeDetails'
import { useLocalInfo } from '../utils/aerodromeDetails'
import css from './LocalInfoSection.module.css'

interface Props {
  /** The aerodrome's id (ICAO, else local id); nothing is shown without one. */
  icao?: string
  /** Section wrapper/title classes of the host popup, so it matches its siblings. */
  sectionClass: string
  titleClass: string
}

function Source({ p }: { p?: DetailProvenance }) {
  if (!p) return null
  return (
    <span className={css.source}>
      {p.review === 'pending' && <span className={css.pending} title="Not reviewed yet: shown in a preview build only">unreviewed</span>}
      {(p.sources?.length ? p.sources : [p]).map((q, i) => q.source_name && (
        <span key={i} className={css.sourceItem}>
          {i > 0 && '· '}
          {q.source_url
            ? <a href={q.source_url} target="_blank" rel="noopener noreferrer">{q.source_name}</a>
            : q.source_name}
        </span>
      ))}
    </span>
  )
}

function Block({ title, prov, children }: { title: string; prov?: DetailProvenance; children: React.ReactNode }) {
  return (
    <div className={css.block}>
      <div className={css.blockHead}><span className={css.blockTitle}>{title}</span><Source p={prov} /></div>
      {children}
    </div>
  )
}

/** Rules under headings: the key lines show, the rest fold away under their heading. */
function RuleGroups({ groups }: { groups: RuleGroup[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  return (
    <>
      {groups.map(g => {
        const key = g.lines.filter(l => l.key), rest = g.lines.filter(l => !l.key)
        const fold = rest.length >= 2          // a single line is not worth a toggle
        const shown = open[g.title] || !fold ? g.lines : key
        return (
          <div key={g.title} className={css.ruleGroup}>
            <div className={css.ruleGroupTitle}>{g.title}</div>
            {shown.length > 0 && <ul className={css.list}>{shown.map((l, i) => <li key={i} className={l.key ? css.keyRule : undefined}>{l.text}</li>)}</ul>}
            {fold && (
              <button type="button" className={css.more} aria-expanded={!!open[g.title]}
                onClick={() => setOpen(o => ({ ...o, [g.title]: !o[g.title] }))}>
                {open[g.title] ? 'Show less' : `${key.length ? `${rest.length} more` : `Show ${rest.length}`}`}
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}

function Content({ info }: { info: LocalInfo }) {
  const pv = info.provenance
  return (
    <>
      {info.circuits.length > 0 && (
        <Block title="Circuits" prov={pv['circuits']}>
          <ul className={css.list}>{info.circuits.map((c, i) => <li key={i}>{formatCircuit(c)}</li>)}</ul>
        </Block>
      )}
      {info.localRules.length > 0 && (
        <Block title="Local rules" prov={pv['local_rules']}>
          {info.localRuleGroups
            ? <RuleGroups groups={info.localRuleGroups} />
            : <ul className={css.list}>{info.localRules.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        </Block>
      )}
      {info.hoursRemarks.length > 0 && (
        <Block title="Hours" prov={pv['hours_remarks']}>
          <ul className={css.list}>{info.hoursRemarks.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </Block>
      )}
      {info.areas.length > 0 && (
        <Block title="Areas" prov={pv['areas']}>
          <ul className={css.list}>
            {info.areas.map((a, i) => (
              <li key={i}>
                <span className={css.swatch} style={{ background: DETAIL_KIND_COLOR[a.kind] }} />
                {DETAIL_KIND_LABEL[a.kind]}{a.name ? `: ${a.name}` : ''}
                {formatLimits(a.floor, a.ceiling) && <span className={css.limits}> {formatLimits(a.floor, a.ceiling)}</span>}
                {a.remark && <div className={css.sub}>{a.remark}</div>}
              </li>
            ))}
          </ul>
        </Block>
      )}
      {info.holdings.length > 0 && (
        <Block title="Holding points" prov={pv['holdings']}>
          <ul className={css.list}>
            {info.holdings.map(h => (
              <li key={h.name}>
                HOLD {h.name}{h.direction ? ` · ${orbitLabel(h.direction)}` : ''}
                {h.description && <div className={css.sub}>{h.description}</div>}
              </li>
            ))}
          </ul>
        </Block>
      )}
      {info.reportingPoints.length > 0 && (
        <Block title="Reporting points" prov={pv['reporting_points']}>
          <div className={css.points}>{info.reportingPoints.map(p => p.name).join(' · ')}</div>
        </Block>
      )}
    </>
  )
}

export default function LocalInfoSection({ icao, sectionClass, titleClass }: Props) {
  const info = useLocalInfo(icao, true)
  if (!info || !hasLocalInfo(info)) return null
  return (
    <div className={sectionClass}>
      <div className={titleClass}>Local information</div>
      <Content info={info} />
      <div className={css.note}>Always check the official publication.</div>
    </div>
  )
}
