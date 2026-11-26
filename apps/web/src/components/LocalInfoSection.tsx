/**
 * "Local information" section of the aerodrome popup (experimental): circuits per runway (and aircraft
 * category), local rules, hours and PPR remarks, local areas with their
 * heights and reporting points, each with its source. Values marked
 * unreviewed exist only in a local preview build. Renders nothing when the
 * aerodrome has no such fields.
 */
import { useState } from 'react'
import {
  DETAIL_KIND_COLOR, DETAIL_KIND_LABEL, formatLimits, hasLocalInfo, orbitLabel, unstatedCircuitEnds, unstatedCircuitNote, circuitEndGroups, type DetailProvenance,
  type LocalInfo, type RuleGroup,
} from '@open-vfr/shared/aerodromeDetails'
import { useCircuitNotes, useLocalInfo } from '../utils/aerodromeDetails'
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
      <span>Source:</span>
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

/** A block of the section; `count` makes it an expander (closed to start with unless it is short (3 lines or fewer): the heading says how many lines are inside, `preview` shows while it is closed). */
function Block({ title, prov, children, count, preview }: { title: string; prov?: DetailProvenance; children: React.ReactNode; count?: number; preview?: React.ReactNode }) {
  const [open, setOpen] = useState(count === undefined || count <= 3)
  const pending = prov?.review === 'pending' && <span className={css.pending} title="Not reviewed yet: shown in a preview build only">unreviewed</span>
  return (
    <div className={css.block}>
      {count === undefined ? (
        <div className={css.blockHead}><span className={css.blockTitle}>{title}</span>{pending}</div>
      ) : (
        <button type="button" className={`${css.blockHead} ${css.blockToggle}`} aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <span className={css.chevron} aria-hidden>{open ? '\u25BE' : '\u25B8'}</span>
          <span className={css.blockTitle}>{title}</span>
          <span className={css.blockCount}>{count}</span>
          {pending}
        </button>
      )}
      {open ? <>{children}<Source p={prov} /></> : preview}
    </div>
  )
}

/** Rules under headings; `onlyKey` keeps just the lines marked key (the preview while the block is closed). */
function RuleGroups({ groups, onlyKey }: { groups: RuleGroup[]; onlyKey?: boolean }) {
  return (
    <>
      {groups.map(g => {
        const shown = onlyKey ? g.lines.filter(l => l.key) : g.lines
        if (!shown.length) return null
        return (
          <div key={g.id} className={css.ruleGroup}>
            <div className={css.ruleGroupTitle}>{g.title}</div>
            <ul className={css.list}>{shown.map((l, i) => <li key={i} className={l.key && !onlyKey ? css.keyRule : undefined}>{l.text}</li>)}</ul>
          </div>
        )
      })}
    </>
  )
}

/** Circuits per runway end, the height once when it is the same everywhere, and which runways have none stated. */
function CircuitList({ info, notes }: { info: LocalInfo; notes: string[] }) {
  const { summary, ends } = circuitEndGroups(info.circuits)
  const none = unstatedCircuitEnds(info)
  return (
    <>
      {summary && <div className={css.height}>{summary}</div>}
      {ends.map(e => (
        <div key={e.runway} className={css.end}>
          <span className={css.rwy} aria-label={`Runway ${e.runway}`}>{e.runway}</span>
          <ul className={css.entries}>
            {e.entries.map((x, i) => (
              <li key={i} className={css.entry}>
                <span className={css.hand}>{x.hand}</span>
                {x.who && <span className={css.who}>{x.who}</span>}
                {x.height && <span className={css.who}>{x.height}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {notes.length > 0 && (
        <ul className={css.notes}>{notes.map(n => <li key={n}>{n}</li>)}</ul>
      )}
      {none.length > 0 && <div className={css.sub}>{unstatedCircuitNote(none)}</div>}
      <div className={css.sub}>Shown on the map when zoomed in.</div>
    </>
  )
}

function Content({ info, notes }: { info: LocalInfo; notes: string[] }) {
  const pv = info.provenance
  return (
    <>
      {info.circuits.length > 0 && (
        <Block title="Circuits" prov={pv['circuits']}>
          <CircuitList info={info} notes={notes} />
        </Block>
      )}
      {info.localRules.length > 0 && (
        <Block title="Local rules" prov={pv['local_rules']} count={info.localRules.length}
          preview={info.localRuleGroups ? <RuleGroups groups={info.localRuleGroups} onlyKey /> : undefined}>
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
  const notes = useCircuitNotes(icao, true)
  if (!info || !hasLocalInfo(info)) return null
  return (
    <div className={sectionClass}>
      <div className={titleClass}>Local information</div>
      <Content info={info} notes={notes} />
      <div className={css.note}>Always check the official publication.</div>
    </div>
  )
}
