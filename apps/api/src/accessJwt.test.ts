import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose'
import { accessConfigFromEnv, createAccessVerifier } from './accessJwt.js'

const cfg = { issuer: 'https://team.cloudflareaccess.com', aud: 'aud-tag' }
const { publicKey, privateKey } = await generateKeyPair('RS256')
const other = await generateKeyPair('RS256')
const verify = createAccessVerifier(cfg, async () => publicKey)

async function token(opts: { email?: string; aud?: string; iss?: string; exp?: string | number; key?: CryptoKey } = {}) {
  return new SignJWT({ email: opts.email ?? 'admin@example.org' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(opts.iss ?? cfg.issuer)
    .setAudience(opts.aud ?? cfg.aud)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? privateKey)
}

test('valid token for the matching admin passes', async () => {
  assert.deepEqual(await verify(await token(), 'Admin@Example.org'), { ok: true })
})

test('missing token fails', async () => {
  assert.equal((await verify(undefined, 'admin@example.org')).ok, false)
})

test('wrong audience fails', async () => {
  assert.equal((await verify(await token({ aud: 'other' }), 'admin@example.org')).ok, false)
})

test('wrong issuer fails', async () => {
  assert.equal((await verify(await token({ iss: 'https://evil.cloudflareaccess.com' }), 'admin@example.org')).ok, false)
})

test('expired token fails', async () => {
  const exp = Math.floor(Date.now() / 1000) - 60
  assert.equal((await verify(await token({ exp }), 'admin@example.org')).ok, false)
})

test('token signed by another key fails', async () => {
  assert.equal((await verify(await token({ key: other.privateKey }), 'admin@example.org')).ok, false)
})

test('email mismatch fails', async () => {
  assert.equal((await verify(await token({ email: 'someone@example.org' }), 'admin@example.org')).ok, false)
})

test('config: both unset = off, one set = error, domain normalised', () => {
  assert.equal(accessConfigFromEnv({}), null)
  assert.throws(() => accessConfigFromEnv({ CF_ACCESS_AUD: 'x' }))
  assert.deepEqual(
    accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com/', CF_ACCESS_AUD: 'x' }),
    { issuer: 'https://team.cloudflareaccess.com', aud: 'x' },
  )
})
