import { useState } from 'react'
import { isDismissible, type SystemMessage } from '@open-vfr/shared/systemMessages'
import { useSystemMessages } from '../hooks/useSystemMessages'
import css from './SystemMessages.module.css'
import { IconX } from '@tabler/icons-react'

const SEVERITY_LABEL: Record<SystemMessage['severity'], string> = {
  info: 'Notice',
  warning: 'Service notice',
  critical: 'Service problem',
}

function Notice({ m, onDismiss }: { m: SystemMessage; onDismiss: () => void }) {
  const [open, setOpen] = useState(m.severity === 'critical')
  const hasDetails = !!m.body || !!m.url
  return (
    <div
      className={`${css.notice} ${css[m.severity]}`}
      role={m.severity === 'critical' ? 'alert' : 'status'}
      aria-label={SEVERITY_LABEL[m.severity]}
      data-testid={`system-message-${m.id}`}
    >
      <div className={css.head}>
        <span className={css.title}>{m.title}</span>
        {hasDetails && (
          <button className={css.btn} onClick={() => setOpen(o => !o)} aria-expanded={open}>
            {open ? 'Less' : 'Details'}
          </button>
        )}
        {isDismissible(m) && (
          <button className={css.btn} onClick={onDismiss} aria-label={`Dismiss: ${m.title}`}><IconX size={14} aria-hidden="true" /></button>
        )}
      </div>
      {open && m.body && <p className={css.body}>{m.body}</p>}
      {open && m.url && (
        <a className={css.link} href={m.url} target="_blank" rel="noopener noreferrer">More information</a>
      )}
    </div>
  )
}

/**
 * Operator notices from VITE_STATUS_URL (planned maintenance, degraded
 * service, outages). Renders nothing when unconfigured or when there is
 * nothing to show. Text only, never HTML.
 */
export default function SystemMessages() {
  const { active, dismiss } = useSystemMessages()
  const [showAll, setShowAll] = useState(false)
  if (active.length === 0) return null
  const shown = showAll ? active : active.slice(0, 1)
  return (
    <div className={css.stack}>
      {shown.map(m => <Notice key={m.id} m={m} onDismiss={() => dismiss(m.id)} />)}
      {active.length > 1 && (
        <button className={css.more} onClick={() => setShowAll(s => !s)}>
          {showAll ? 'Show fewer' : `+${active.length - 1} more notice${active.length > 2 ? 's' : ''}`}
        </button>
      )}
    </div>
  )
}
