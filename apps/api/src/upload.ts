/**
 * Upload helpers for /api/poh-extract: a size-capped multipart reader and a
 * PDF signature check. Kept separate from index.ts so they can be tested
 * without the Azure OpenAI client.
 */

/** Thrown by readLimitedFormData when the body exceeds its cap. */
export class BodyTooLarge extends Error {
  constructor() { super('Request body too large') }
}

/**
 * Read a multipart body, failing as soon as it exceeds `maxBytes`: checks
 * Content-Length up front and counts bytes as they stream, so a chunked or
 * lying client can't make the server buffer more than the cap.
 */
export async function readLimitedFormData(req: Request, maxBytes: number): Promise<FormData> {
  const declared = Number(req.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge()
  if (!req.body) return req.formData()
  // Explicit reader rather than a pipe: on overflow the source is cancelled
  // and that cancel awaited here, so nothing is left to reject later
  // (an unhandled rejection would take the whole process down).
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let seen = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    seen += value.byteLength
    if (seen > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new BodyTooLarge()
    }
    chunks.push(value)
  }
  // Only the content type (multipart boundary) matters for parsing.
  const headers = new Headers()
  const type = req.headers.get('content-type')
  if (type) headers.set('content-type', type)
  return new Request(req.url, { method: req.method, headers, body: new Blob(chunks as BlobPart[]) }).formData()
}

/** PDF header: `%PDF-` within the first 1024 bytes (ISO 32000-1 7.5.2 tolerance). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-')
}
