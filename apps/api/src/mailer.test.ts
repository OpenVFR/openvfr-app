import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { parseConnectionString, signRequest } from './mailer.js'

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
