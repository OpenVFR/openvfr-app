/**
 * "Use your own AI assistant" help: a small button that opens the setup steps,
 * the connector address and example questions for the place it sits in.
 * Rendered only when the server offers the assistant connection to this
 * account (see useAssistantMcpUrl). Product-neutral; details are in the guide.
 */
import { useRef, useState } from 'react'
import { useModalFocus } from '../hooks/useModalFocus'
import { createPortal } from 'react-dom'
import { IconSparkles, IconX } from '@tabler/icons-react'
import { ASSISTANT_STEPS, ASSISTANT_DISCLAIMER, assistantExamples, type AssistantHelpTopic } from '@open-vfr/shared/assistantHelp'
import css from './AssistantHelp.module.css'

async function copyText(t: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(t); return true } catch { return false }
}

function HelpDialog({ topic, mcpUrl, onClose, returnFocusTo }: { topic: AssistantHelpTopic; mcpUrl: string; onClose: () => void; returnFocusTo: HTMLElement | null }) {
  const [copied, setCopied] = useState('')
  const cardRef = useModalFocus(onClose, returnFocusTo)

  async function copy(what: string, t: string) {
    if (await copyText(t)) { setCopied(what); setTimeout(() => setCopied(''), 1500) }
  }

  return createPortal(
    <div className={css.backdrop} role="dialog" aria-modal="true" aria-labelledby="assistant-help-title" onClick={onClose}>
      <div className={css.card} ref={cardRef} onClick={(e) => e.stopPropagation()}>
        <div className={css.head}>
          <h2 id="assistant-help-title" className={css.title}>Use your AI assistant</h2>
          <button type="button" className={css.close} aria-label="Close" onClick={onClose}><IconX size={16} aria-hidden="true" /></button>
        </div>
        <p className={css.text}>Ask your own AI assistant about your flight, typed or spoken. It uses the same data and checks as this app.</p>
        <ol className={css.steps}>{ASSISTANT_STEPS.map(s => <li key={s}>{s}</li>)}</ol>
        <div className={css.row}>
          <code className={css.url}>{mcpUrl}</code>
          <button type="button" className={css.btn} onClick={() => void copy('url', mcpUrl)}>Copy</button>
        </div>
        <p className={css.label}>Try asking</p>
        <ul className={css.examples}>
          {assistantExamples(topic).map(ex => (
            <li key={ex}>
              <button type="button" className={css.example} title="Copy" onClick={() => void copy(ex, ex)}>{ex}</button>
            </li>
          ))}
        </ul>
        {/* The confirmation sits beside the buttons, so their names (the questions) never change. */}
        <p className={css.note} role="status">{copied ? 'Copied.' : '\u00a0'}</p>
        <p className={css.note}>{ASSISTANT_DISCLAIMER}</p>
      </div>
    </div>,
    document.body,
  )
}

export default function AssistantHelp({ topic, mcpUrl, className }: { topic: AssistantHelpTopic; mcpUrl: string | null; className?: string }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  if (!mcpUrl) return null
  return (
    <>
      <button ref={triggerRef} type="button" className={className ?? css.trigger} title="Use your own AI assistant with OpenVFR" aria-label="Use your own AI assistant with OpenVFR" onClick={(e) => { e.stopPropagation(); setOpen(true) }}>
        <IconSparkles size={14} aria-hidden="true" />
      </button>
      {open && <HelpDialog topic={topic} mcpUrl={mcpUrl} onClose={() => setOpen(false)} returnFocusTo={triggerRef.current} />}
    </>
  )
}
