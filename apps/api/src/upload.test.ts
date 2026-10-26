import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { BodyTooLarge, readLimitedFormData, looksLikePdf } from './upload.js'

const URL_ = 'http://localhost/api/poh-extract'

function formRequest(fileBytes: number): Request {
  const form = new FormData()
  form.set('file', new File([new Uint8Array(fileBytes).fill(0x41)], 'poh.pdf', { type: 'application/pdf' }))
  return new Request(URL_, { method: 'POST', body: form })
}

test('reads a body under the cap', async () => {
  const form = await readLimitedFormData(formRequest(10_000), 1_000_000)
  const file = form.get('file')
  assert.ok(file instanceof File)
  assert.equal(file.size, 10_000)
  assert.equal(file.name, 'poh.pdf')
})

/**
 * Send `body` to a real @hono/node-server (the production request stream),
 * chunked (no Content-Length) unless `contentLength` is given, and return the
 * status the route answered with. Fails on any unhandled rejection meanwhile.
 */
async function viaServer(body: Buffer, contentType: string, maxBytes: number, contentLength?: number): Promise<{ status: number; text: string }> {
  const app = new Hono()
  app.post('/u', async (c) => {
    try {
      const form = await readLimitedFormData(c.req.raw, maxBytes)
      return c.text(`ok ${(form.get('file') as File).size}`)
    } catch (e) {
      return e instanceof BodyTooLarge ? c.text('too large', 413) : c.text('bad', 400)
    }
  })
  const unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => { unhandled.push(e) }
  process.on('unhandledRejection', onUnhandled)
  const server = serve({ fetch: app.fetch, port: 0 })
  await new Promise((r) => server.once('listening', r))
  const { port } = server.address() as AddressInfo
  try {
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const headers: Record<string, string | number> = { 'content-type': contentType }
      if (contentLength !== undefined) headers['content-length'] = contentLength
      const req = httpRequest({ port, path: '/u', method: 'POST', headers }, (res) => {
        let text = ''
        res.on('data', (d) => { text += d })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      })
      // The server may answer and close before the whole body is written.
      req.on('error', (e) => (e as NodeJS.ErrnoException).code === 'EPIPE' || (e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e))
      for (let i = 0; i < body.length; i += 16_384) req.write(body.subarray(i, i + 16_384))
      req.end()
    })
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(unhandled, [], 'no unhandled rejection')
    return res
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await new Promise((r) => server.close(r))
  }
}

async function multipart(fileBytes: number): Promise<{ body: Buffer; type: string }> {
  const r = formRequest(fileBytes)
  return { body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type')! }
}

test('real server: chunked body under the cap is read', async () => {
  const m = await multipart(10_000)
  const r = await viaServer(m.body, m.type, 1_000_000)
  assert.equal(r.status, 200)
  assert.equal(r.text, 'ok 10000')
})

test('real server: chunked body over the cap is refused while streaming', async () => {
  const m = await multipart(500_000)
  const r = await viaServer(m.body, m.type, 100_000)
  assert.equal(r.status, 413)
})

test('refuses a declared Content-Length over the cap without reading', async () => {
  const req = new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '5000000' },
    body: 'tiny',
  })
  await assert.rejects(readLimitedFormData(req, 1_000_000), BodyTooLarge)
})


test('a malformed body is a plain error, not BodyTooLarge', async () => {
  const req = new Request(URL_, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: 'garbage' })
  await assert.rejects(readLimitedFormData(req, 1_000_000), (e) => !(e instanceof BodyTooLarge))
})

test('PDF signature check', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  assert.ok(looksLikePdf(enc('%PDF-1.7\n...')))
  assert.ok(looksLikePdf(enc('\n\n  junk before header %PDF-1.4')))     // allowed within 1024 bytes
  assert.ok(!looksLikePdf(enc('<html>%PD F-</html>')))
  assert.ok(!looksLikePdf(new Uint8Array([0x89, 0x50, 0x4e, 0x47])))   // PNG
  const late = new Uint8Array(2000).fill(0x20)
  late.set(enc('%PDF-'), 1500)
  assert.ok(!looksLikePdf(late))
})
