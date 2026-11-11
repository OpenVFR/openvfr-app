import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { parseConnectionString, signRequest, logUnsent } from './mailer.js'

const KEY = Buffer.from('secret-key-bytes').toString('base64')

test('parseConnectionString keeps = in the access key', () => {
  const c = parseConnectionString(`endpoint=https://x.communication.azure.com/;accesskey=${KEY}`)
  assert.equal(c.endpoint, 'https://x.communication.azure.com')
  assert.equal(c.accessKey, KEY)
  assert.ok(KEY.endsWith('='))
})

test('parseConnectionString rejects incomplete strings', () => {
  assert.throws(() => parseConnectionString('endpoint=https://x.communication.azure.com/'))
})

test('signRequest builds the documented HMAC', () => {
  const conn = { endpoint: 'https://x.communication.azure.com', accessKey: KEY }
  const date = new Date('2026-01-02T03:04:05Z')
  const body = '{"a":1}'
  const path = '/emails:send?api-version=2023-03-31'
  const h = signRequest(conn, 'post', path, body, date)
  const hash = createHash('sha256').update(body).digest('base64')
  const sig = createHmac('sha256', Buffer.from(KEY, 'base64'))
    .update(`POST\n${path}\n${date.toUTCString()};x.communication.azure.com;${hash}`)
    .digest('base64')
  assert.equal(h['x-ms-content-sha256'], hash)
  assert.equal(h['x-ms-date'], date.toUTCString())
  assert.equal(h.Authorization, `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${sig}`)
})

test('no provider: the message is printed outside production, never in production', () => {
  const msg = { to: 'a@example.org', subject: 'Your OpenVFR sign-in code', text: 'Your verification code is: 123456\n\nExpires in 10 minutes.' }
  const out: string[] = []
  logUnsent(msg, { NODE_ENV: 'development' }, s => out.push(s))
  assert.match(out[0]!, /123456/)
  assert.match(out[0]!, /a@example\.org/)
  out.length = 0
  logUnsent(msg, {}, s => out.push(s))                       // NODE_ENV unset counts as dev
  assert.match(out[0]!, /123456/)
  out.length = 0
  logUnsent(msg, { NODE_ENV: 'production' }, s => out.push(s))
  assert.doesNotMatch(out[0]!, /123456/)
  assert.match(out[0]!, /WARNING/)
  out.length = 0
  logUnsent({ to: 'b@example.org', subject: 'Confirm', html: '<p>Open <a href="x">https://x/link</a></p>' }, {}, s => out.push(s))
  assert.match(out[0]!, /Open https:\/\/x\/link/)
})
