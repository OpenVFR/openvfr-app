/**
 * POH (Pilot's Operating Handbook) extraction via the open-vfr Hono API server.
 *
 * POST the raw PDF to /api/poh-extract. The server uploads it to Azure OpenAI
 * Files API, waits for processing, calls responses.create, then returns the
 * parsed fields via SSE (text/event-stream).
 *
 * Azure credentials live only in the server environment — never in the browser.
 */

import { API_BASE_URL } from './env'

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when the server returns a rate-limit event with a suggested retry delay. */
export class RateLimitError extends Error {
  retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds: number) {
    super(message)
    this.name = 'RateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// ---------------------------------------------------------------------------
// Result type — subset of AircraftLibrary's FormState (all strings)
// ---------------------------------------------------------------------------
export type PohExtractResult = {
  name?:             string
  icaoType?:         string
  cruiseAltFt?:      string
  cruiseIas?:        string
  fuelBurnLhr?:      string
  maxFuelL?:         string
  taxiFuelL?:        string
  landingFuelL?:     string
  serviceCeilingFt?: string
  rocSlFpm?:         string
  climbIas?:         string
  climbFuelLhr?:     string
  descentFpm?:       string
  descentIas?:       string
  bestGlideIas?:     string
  glideRatio?:       string
  takeoffSpeedKts?:  string
}

// ---------------------------------------------------------------------------
// Server-side extraction
// ---------------------------------------------------------------------------

const MAX_FILE_MB = 50

/**
 * Upload a POH PDF to the open-vfr API server and return parsed performance
 * fields. Progress stages are surfaced via the optional `onStage` callback.
 * Throws a user-readable Error (or RateLimitError) on any failure.
 */
export async function extractPohViaServer(
  file: File,
  onStage?: (stage: 'uploading' | 'processing' | 'extracting') => void,
): Promise<PohExtractResult> {
  const fileMb = file.size / (1024 * 1024)
  if (fileMb > MAX_FILE_MB) {
    throw new Error(
      `File is ${fileMb.toFixed(1)} MB — maximum is ${MAX_FILE_MB} MB. ` +
      'Use a text-only or compressed version of the POH.',
    )
  }

  const fd = new FormData()
  fd.append('file', file)

  const resp = await fetch(`${API_BASE_URL}/api/poh-extract`, { method: 'POST', body: fd, credentials: 'include' })

  if (!resp.ok || !resp.body) {
    // Pre-stream errors (503, 400, 401, 413, 429) come back as plain JSON
    const json = await resp.json() as { error?: string, retryAfterSeconds?: number }
    if (resp.status === 429 && typeof json.retryAfterSeconds === 'number') {
      throw new RateLimitError(json.error ?? 'Rate limit reached.', json.retryAfterSeconds)
    }
    throw new Error(json.error ?? `Server error ${resp.status}`)
  }

  // Read SSE stream line by line
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE messages are separated by blank lines (\n\n)
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()

      let msg: Record<string, unknown>
      try { msg = JSON.parse(raw) as Record<string, unknown> } catch { continue }

      if (typeof msg['stage'] === 'string') {
        onStage?.(msg['stage'] as 'uploading' | 'processing' | 'extracting')
        continue
      }

      if (typeof msg['error'] === 'string') {
        if (typeof msg['retryAfterSeconds'] === 'number') {
          throw new RateLimitError(msg['error'], msg['retryAfterSeconds'])
        }
        throw new Error(msg['error'])
      }

      if (msg['result'] != null) {
        const parsed = msg['result'] as Record<string, unknown>

        const numStr = (key: string): string | undefined => {
          const v = parsed[key]
          if (v == null) return undefined
          const n = parseFloat(String(v))
          return isNaN(n) ? undefined : String(Math.round(n * 100) / 100)
        }

        const strVal = (key: string): string | undefined => {
          const v = parsed[key]
          if (v == null || v === '') return undefined
          return String(v)
        }

        return {
          name:             strVal('name'),
          icaoType:         strVal('icaoType'),
          cruiseAltFt:      numStr('cruiseAltFt'),
          cruiseIas:        numStr('cruiseIas'),
          fuelBurnLhr:      numStr('fuelBurnLhr'),
          maxFuelL:         numStr('maxFuelL'),
          taxiFuelL:        numStr('taxiFuelL'),
          landingFuelL:     numStr('landingFuelL'),
          serviceCeilingFt: numStr('serviceCeilingFt'),
          rocSlFpm:         numStr('rocSlFpm'),
          climbIas:         numStr('climbIas'),
          climbFuelLhr:     numStr('climbFuelLhr'),
          descentFpm:       numStr('descentFpm'),
          descentIas:       numStr('descentIas'),
          bestGlideIas:     numStr('bestGlideIas'),
          glideRatio:       numStr('glideRatio'),
          takeoffSpeedKts:  numStr('takeoffSpeedKts'),
        }
      }
    }
  }

  throw new Error('Server closed the connection without returning a result.')
}
