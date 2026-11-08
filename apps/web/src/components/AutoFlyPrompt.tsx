import css from './AutoFlyPrompt.module.css'
import { IconX } from '@tabler/icons-react'

export default function AutoFlyPrompt({ kind, onAccept, onDismiss }: {
  kind: 'start' | 'stop'; onAccept: () => void; onDismiss: () => void
}) {
  return (
    <div className={css.prompt} role="alertdialog" aria-label={kind === 'start' ? 'Airborne detected' : 'Landing detected'}>
      <span className={css.text}>{kind === 'start' ? 'Airborne? Start flying mode' : 'Landed? Stop flying mode'}</span>
      <button className={css.accept} onClick={onAccept}>{kind === 'start' ? 'Start' : 'Stop'}</button>
      <button className={css.dismiss} onClick={onDismiss} aria-label="Dismiss"><IconX size={14} aria-hidden="true" /></button>
    </div>
  )
}
