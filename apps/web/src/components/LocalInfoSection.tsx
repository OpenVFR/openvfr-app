/**
 * "Local information" section of the aerodrome popup (experimental,
 * EXPERIMENTAL_AERODROME_DETAILS): circuits per runway (and aircraft
 * category), local rules, hours and PPR remarks, local areas with their
 * heights and reporting points, each with its source. Values marked
 * unreviewed exist only in a local preview build. Renders nothing when the
 * aerodrome has no such fields.
 */
import {
  DETAIL_KIND_COLOR, DETAIL_KIND_LABEL, formatCircuit, formatLimits, hasLocalInfo, orbitLabel, type DetailProvenance,
  type LocalInfo,
} from '@open-vfr/shared/aerodromeDetails'
import { useLocalInfo } from '../utils/aerodromeDetails'
import { EXPERIMENTAL_AERODROME_DETAILS } from '../utils/env'
import css from './LocalInfoSection.module.css'

interface Props {
  icao: string
  /** Section wrapper/title classes of the host popup, so it matches its siblings. */
  sectionClass: string
  titleClass: string
}

function Source({ p }: { p?: DetailProvenance }) {
  if (!p) return null
  return (
    <span className={css.source}>
      {p.review === 'pending' && <span className={css.pending} title="Not reviewed yet: shown in a preview build only">unreviewed</span>}
      {p.source_name && (p.source_url
        ? <a href={p.source_url} target="_blank" rel="noopener noreferrer">{p.source_name}</a>
        : p.source_name)}
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
          <ul className={css.list}>{info.localRules.map((r, i) => <li key={i}>{r}</li>)}</ul>
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
  const info = useLocalInfo(icao, EXPERIMENTAL_AERODROME_DETAILS)
  if (!EXPERIMENTAL_AERODROME_DETAILS || !info || !hasLocalInfo(info)) return null
  return (
    <div className={sectionClass}>
      <div className={titleClass}>Local information</div>
      <Content info={info} />
      <div className={css.note}>Always check the official publication.</div>
    </div>
  )
}
