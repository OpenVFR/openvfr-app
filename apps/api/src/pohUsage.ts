/**
 * One log line per POH extraction with what it cost: the model's token usage, the upload size and the time the
 * model took. A POH goes to the model as one whole-PDF request, so its size in tokens decides whether the
 * deployment's tokens-per-minute capacity is enough; without this line that size is a guess.
 * The line holds numbers only (no file name, no text, no user).
 */
export interface ResponseUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)

export function pohUsageLine(usage: ResponseUsage | null | undefined, fileMb: number, elapsedMs: number): string {
  const parts = [
    `file=${fileMb.toFixed(1)}MB`,
    `model_time=${(elapsedMs / 1000).toFixed(1)}s`,
  ]
  if (!usage) return `[poh-extract] usage: ${parts.join(' ')} tokens=not reported`
  const input = n(usage.input_tokens)
  const output = n(usage.output_tokens)
  const total = n(usage.total_tokens) ?? (input !== null && output !== null ? input + output : null)
  const reasoning = n(usage.output_tokens_details?.reasoning_tokens)
  const cached = n(usage.input_tokens_details?.cached_tokens)
  parts.push(`input_tokens=${input ?? '?'}`, `output_tokens=${output ?? '?'}`, `total_tokens=${total ?? '?'}`)
  if (reasoning !== null) parts.push(`reasoning_tokens=${reasoning}`)
  if (cached !== null && cached > 0) parts.push(`cached_tokens=${cached}`)
  return `[poh-extract] usage: ${parts.join(' ')}`
}
