/**
 * Fill an aircraft profile from a POH with the pilot's own AI assistant.
 *
 * The app never sees the PDF and calls no model: the pilot copies a prompt,
 * sends it with the POH to any chat assistant, and pastes the JSON answer
 * back. Parsing and plausibility checks live in @open-vfr/shared/pohImport.
 */
import { useMemo, useRef, useState } from 'react'
import { buildPohPrompt, parsePohReply, PohReplyError, type PohReply } from '@open-vfr/shared/pohImport'
import css from './PohAssistantImport.module.css'

export default function PohAssistantImport({ onApply }: { onApply: (reply: PohReply) => void }) {
  const prompt = useMemo(() => buildPohPrompt(), [])
  const [reply, setReply] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<'idle' | 'ok' | 'manual'>('idle')
  const promptRef = useRef<HTMLTextAreaElement>(null)

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied('ok')
    } catch {
      // Clipboard API blocked (insecure context, permissions): show the prompt
      // selected so the pilot can copy it by hand.
      setCopied('manual')
      requestAnimationFrame(() => { promptRef.current?.focus(); promptRef.current?.select() })
    }
  }

  function apply() {
    try {
      const r = parsePohReply(reply)
      setError('')
      setReply('')
      onApply(r)
    } catch (err) {
      setError(err instanceof PohReplyError ? err.message : 'Could not read the answer.')
    }
  }

  return (
    <div className={css.box} role="region" aria-label="Fill from POH with your AI assistant">
      <ol className={css.steps}>
        <li>
          <button type="button" className={css.btn} onClick={copyPrompt}>
            {copied === 'ok' ? 'Prompt copied' : 'Copy prompt'}
          </button>
        </li>
        <li>Open your AI assistant (any chat assistant that reads PDFs), attach the POH PDF and paste the prompt.</li>
        <li>Copy the assistant's whole answer and paste it here:</li>
      </ol>
      {copied === 'manual' && (
        <textarea
          ref={promptRef}
          className={css.text}
          readOnly
          rows={4}
          value={prompt}
          aria-label="Prompt for your AI assistant"
        />
      )}
      <textarea
        className={css.text}
        rows={4}
        value={reply}
        placeholder='{"name": "…", "cruiseIas": …}'
        aria-label="Answer from your AI assistant"
        onChange={e => { setReply(e.target.value); setError('') }}
      />
      {error && <p className={css.error}>{error}</p>}
      <div className={css.actions}>
        <button type="button" className={css.btnPrimary} disabled={!reply.trim()} onClick={apply}>
          Fill in the form
        </button>
      </div>
      <p className={css.note}>
        The PDF stays between you and your assistant. Check every value against the POH before you save.
      </p>
    </div>
  )
}
