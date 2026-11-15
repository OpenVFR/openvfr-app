import { IconPlaneDeparture, IconPlus } from '@tabler/icons-react'
import css from './RouteActionButton.module.css'

export interface RouteActionProps {
  /** 'direct' = fly direct to it (plane icon); anything else = start / extend a route (plus icon). */
  kind?: 'route' | 'direct'
  /** The full wording ("Start route here", "Direct to ESMS"): the tooltip and the accessible name. */
  label: string
  /** The word on the button, as native shows it ("Route", "Direct"); the label when absent. */
  short?: string
  onClick: () => void
}

/** The header action of an aerodrome / feature popup: a filled accent pill with an icon and one short word, like native's "+ Route". */
export default function RouteActionButton({ kind, label, short, onClick }: RouteActionProps) {
  return (
    <button type="button" className={css.btn} onClick={onClick} title={label} aria-label={label}>
      {kind === 'direct' ? <IconPlaneDeparture size={13} aria-hidden="true" /> : <IconPlus size={13} stroke={2.5} aria-hidden="true" />}
      <span>{short ?? (kind === 'direct' ? label : 'Route')}</span>
    </button>
  )
}
