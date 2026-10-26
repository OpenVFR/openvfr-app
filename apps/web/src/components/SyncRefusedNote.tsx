import { rejectionText, type RejectedRow } from '@open-vfr/shared/cloudSync'
import css from './SyncRefusedNote.module.css'

/**
 * Note on a list row the server refused for good (too large, account limit):
 * the row exists on this device only. The server's answer is in the tooltip.
 */
export default function SyncRefusedNote({ row }: { row: RejectedRow | undefined }) {
  if (!row) return null
  return (
    <span
      className={css.note}
      title={`This item is kept on this device only: the server refused it, so it is not in your account and not on your other devices. Make it smaller or remove something to free space, then save it again.\n\nServer: ${row.detail}`}
    >
      ⚠ {rejectionText(row.reason)}
    </span>
  )
}
