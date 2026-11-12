/**
 * Fill an aircraft profile from a POH with the pilot's own AI assistant.
 *
 * The app never sees the PDF and calls no model: the pilot copies a prompt,
 * sends it with the POH to any chat assistant, and pastes the JSON answer
 * back. Parsing and plausibility checks live in @open-vfr/shared/pohImport.
 */
import { useMemo, useRef, useState } from 'react'
import { buildPohPrompt, parsePohReply, PohReplyError, POH_MODEL_ADVICE, type PohReply } from '@open-vfr/shared/pohImport'
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
      <p className={css.tip}><strong>Tip:</strong> {POH_MODEL_ADVICE}</p>

      <div className={css.step}>
        <span className={css.num} aria-hidden="true">1</span>
        <div className={css.stepBody}>
          <p className={css.stepTitle}>Copy the prompt</p>
          <button type="button" className={css.primary} onClick={copyPrompt}>
            {copied === 'ok' ? 'Prompt copied ✓' : 'Copy prompt'}
          </button>
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
        </div>
      </div>

      <div className={css.step}>
        <span className={css.num} aria-hidden="true">2</span>
        <div className={css.stepBody}>
          <p className={css.stepTitle}>Ask your assistant</p>
          <p className={css.stepText}>Open the AI assistant you already use (any that reads PDF files), attach the POH and paste the prompt.</p>
        </div>
      </div>

      <div className={css.step}>
        <span className={css.num} aria-hidden="true">3</span>
        <div className={css.stepBody}>
          <p className={css.stepTitle}>Paste its answer</p>
          <textarea
            className={css.text}
            rows={4}
            value={reply}
            placeholder="Paste the whole answer here"
            aria-label="Answer from your AI assistant"
            onChange={e => { setReply(e.target.value); setError('') }}
          />
          {error && <p className={css.error}>{error}</p>}
          <button type="button" className={css.primary} disabled={!reply.trim()} onClick={apply}>
            Apply to the form
          </button>
        </div>
      </div>

      <p className={css.note}>
        The PDF stays between you and your assistant. Check every value against the POH before you save.
      </p>
    </div>
  )
}
