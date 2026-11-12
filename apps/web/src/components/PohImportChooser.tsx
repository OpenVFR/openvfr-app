/**
 * "Fill from your POH": the ways to get an aircraft profile from a POH, side by
 * side, best first. Choosing one opens its steps below the row (the assistant
 * paste flow, the connector address) or starts it (the built-in PDF extractor).
 * The connection row only shows where the server offers it to this account.
 */
import { useState } from 'react'
import { POH_MODEL_ADVICE } from '@open-vfr/shared/pohImport'
import type { PohReply } from '@open-vfr/shared/pohImport'
import { ASSISTANT_STEPS } from '@open-vfr/shared/assistantHelp'
import { useAccountFlags } from '../hooks/useAssistantMcpUrl'
import PohAssistantImport from './PohAssistantImport'
import css from './PohImportChooser.module.css'

type Method = 'paste' | 'connect' | null

export default function PohImportChooser({ busy, onApply, onPickPdf }: {
  /** The built-in extractor is running: its row is disabled. */
  busy: boolean
  onApply: (reply: PohReply) => void
  /** Opens the file picker of the built-in extractor. */
  onPickPdf: () => void
}) {
  const [method, setMethod] = useState<Method>(null)
  const flags = useAccountFlags(true)
  const mcpUrl = flags.assistantMcpUrl
  const [copied, setCopied] = useState(false)
  const toggle = (m: Exclude<Method, null>) => setMethod(cur => (cur === m ? null : m))

  async function copy(t: string) {
    try { await navigator.clipboard.writeText(t); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* the text stays selectable */ }
  }

  return (
    <div className={css.box} role="group" aria-label="Fill the aircraft from its POH">
      <p className={css.title}>Fill from your POH</p>

      <button type="button" className={`${css.row} ${method === 'paste' ? css.rowOpen : ''}`} aria-expanded={method === 'paste'} onClick={() => toggle('paste')}>
        <span className={css.rowHead}><span className={css.rowName}>Use your AI assistant</span><span className={css.badge}>Recommended</span></span>
        <span className={css.rowText}>Copy a prompt, attach the POH in your assistant, paste its answer back here. Nothing is uploaded to OpenVFR.</span>
      </button>
      {method === 'paste' && <PohAssistantImport onApply={r => { setMethod(null); onApply(r) }} />}

      {mcpUrl && (
        <>
          <button type="button" className={`${css.row} ${method === 'connect' ? css.rowOpen : ''}`} aria-expanded={method === 'connect'} onClick={() => toggle('connect')}>
            <span className={css.rowHead}><span className={css.rowName}>Connect your AI assistant</span></span>
            <span className={css.rowText}>Your assistant creates the aircraft itself from the POH and you review it here. Connect it once, then ask.</span>
          </button>
          {method === 'connect' && (
            <div className={css.panel}>
              <p className={css.advice}>{POH_MODEL_ADVICE}</p>
              <ol className={css.steps}>
                {ASSISTANT_STEPS.slice(0, 2).map(s => <li key={s}>{s}</li>)}
                <li>Attach the POH and ask: “Add my aircraft from the attached POH.”</li>
              </ol>
              <div className={css.addr}>
                <code className={css.url}>{mcpUrl}</code>
                <button type="button" className={css.copy} onClick={() => void copy(mcpUrl)}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <p className={css.note}>The aircraft shows “Check before use” until you open and save it.</p>
            </div>
          )}
        </>
      )}

      {/* Only where the server has the cloud model (the app needs a signed-in account anyway). */}
      {flags.pohExtract && (
        <button type="button" className={`${css.row} ${css.rowLast}`} disabled={busy} onClick={onPickPdf}>
          <span className={css.rowHead}><span className={css.rowName}>Use built-in AI assistant</span><span className={css.badgeMuted}>Last option</span></span>
          <span className={css.rowText}>Upload the performance pages and OpenVFR&apos;s own AI reads them. Quick, but less accurate, especially with diagrams and images. The PDF goes to a cloud service.</span>
        </button>
      )}

    </div>
  )
}
