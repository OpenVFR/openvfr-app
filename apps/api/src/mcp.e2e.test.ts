/**
 * Assistant connection end to end, in process: the production OAuth/MCP
 * plugin configuration (assistantAuth.ts) and the real MCP endpoint (mcp.ts)
 * on an in-memory Postgres (PGlite). User data and weather are stubbed.
 *
 * Covers what an assistant does: 401 challenge -> discovery -> client
 * registration -> user sign-in -> consent (scopes the user narrows) -> token
 * -> MCP calls, plus the tool contract (descriptions, annotations, writes
 * refused without aircraft:write), refresh rotation and replay, disconnect,
 * and that the SQL migration matches better-auth's schema.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'

process.env['DATABASE_URL'] ??= 'postgres://unused@127.0.0.1:1/unused'

const { serve } = await import('@hono/node-server')
const { Hono } = await import('hono')
const { betterAuth } = await import('better-auth')
const { bearer, emailOTP } = await import('better-auth/plugins')
const { getMigrations } = await import('better-auth/db/migration')
const { PGlite } = await import('@electric-sql/pglite')
const { PGliteDialect } = await import('kysely-pglite-dialect')
const { assistantConnectionPlugins, mcpResource, SCOPE_BRIEFING, SCOPE_ROUTES, SCOPE_ROUTES_WRITE, SCOPE_AIRCRAFT_WRITE } = await import('./assistantAuth.js')
const { buildPointIndex } = await import('@open-vfr/shared/routeIdentifiers')
const { createMcpEndpoint } = await import('./mcp.js')

const port = await new Promise<number>((resolve) => {
  const s = createServer().listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)) })
})
const BASE = `http://localhost:${port}`
const APP = 'http://localhost:5174'
const RESOURCE = mcpResource(BASE)
const REDIRECT = 'http://127.0.0.1:9999/callback'
const m = (n: string) => ({ modelName: n })

let lastOtp = ''
const saved: unknown[] = []
const savedRoutes: { id: string; name: string; assistantReview?: { by: string } }[] = []
const auth = betterAuth({
  secret: 'test-secret-0123456789-0123456789-0123456789',
  baseURL: BASE,
  trustedOrigins: [BASE, APP],
  database: { dialect: new PGliteDialect(new PGlite()), type: 'postgres' } as never,
  user: m('ba_user'), session: m('ba_session'), account: m('ba_account'), verification: m('ba_verification'),
  disabledPaths: ['/token'],
  plugins: [
    bearer(),
    emailOTP({ sendVerificationOTP: async ({ otp }) => { lastOtp = otp } }),
    ...assistantConnectionPlugins({ baseUrl: BASE, appOrigin: APP }),
  ],
})

let server: { close: () => void } | null = null
let as: Record<string, string> = {}
let clientId = ''
let cookie = ''

before(async () => {
  await (await getMigrations((await auth.$context).options)).runMigrations()
  const app = new Hono()
  app.all('/api/auth/*', (c) => auth.handler(c.req.raw))
  for (const p of ['/.well-known/oauth-authorization-server/*', '/.well-known/oauth-protected-resource/*', '/.well-known/oauth-protected-resource'])
    app.on(['GET', 'HEAD'], p, (c) => auth.handler(c.req.raw))
  const endpoint = createMcpEndpoint(auth as never, {
    briefings: {
      savedRoutes: async () => [{ id: 'r1', name: 'Home loop', waypoints: [{ lat: 59.35, lng: 17.94, name: 'ESSB' }, { lat: 59.65, lng: 17.92, name: 'ESSA' }], legOverrides: [{}], updatedAt: 0 }],
      userAircraft: async () => [{ id: 'a1', name: 'Rotax', registration: 'SE-TST', icaoType: 'C42', category: 'MICRO', cruiseIas: 90, fuelBurnLhr: 14, maxFuelL: 60 }],
      aircraftById: async () => null,
      defaultAircraft: async () => ({ aircraft: { id: 'a1', name: 'Rotax', registration: 'SE-TST', icaoType: 'C42', category: 'MICRO', cruiseIas: 90, fuelBurnLhr: 14, maxFuelL: 60 }, why: 'the only aircraft profile' }),
    } as never,
    weather: async () => ({ metar: 'ESSB 111020Z 24012KT CAVOK 08/03 Q1013', taf: null }),
    appOrigin: APP, resource: RESOURCE,
    scopeBriefing: SCOPE_BRIEFING, scopeRoutes: SCOPE_ROUTES, scopeAircraftWrite: SCOPE_AIRCRAFT_WRITE,
    saveAircraft: async (_u, doc) => { saved.push(doc) },
    scopeRoutesWrite: SCOPE_ROUTES_WRITE,
    saveRoute: async (_u, doc) => { savedRoutes.push(doc as never) },
    pointIndex: async () => buildPointIndex({ aerodromes: { features: [
      { geometry: { coordinates: [17.94, 59.35] }, properties: { icao: 'ESSB', elevation_ft: 47 } },
      { geometry: { coordinates: [17.92, 59.65] }, properties: { icao: 'ESSA', elevation_ft: 137 } },
    ] } }),
    clientName: async () => 'Test Assistant',
    // Briefings themselves are covered by briefing.test.ts.
    takeBriefing: () => false,
    jwksUrl: `${BASE}/api/auth/jwks`,
  })
  app.post('/mcp', (c) => endpoint(c.req.raw))
  server = serve({ fetch: app.fetch, port })
})
after(() => server?.close())

const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) })
const json = (o: unknown, extra: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: APP, ...extra }, body: JSON.stringify(o) })

async function connect(scope: string): Promise<{ access_token: string; refresh_token: string; scope: string }> {
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(as['authorization_endpoint']!)
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: [SCOPE_BRIEFING, SCOPE_ROUTES, SCOPE_ROUTES_WRITE, SCOPE_AIRCRAFT_WRITE, 'offline_access'].join(' '),
    state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: RESOURCE, prompt: 'consent',
  }).toString()
  const step = await (await fetch(authorize, { headers: { cookie } })).json() as { url: string }
  const consentPage = new URL(step.url)
  assert.equal(consentPage.origin + consentPage.pathname, `${APP}/oauth/consent`)
  const consent = await (await fetch(`${BASE}/api/auth/oauth2/consent`, json({ accept: true, scope, oauth_query: consentPage.search.slice(1) }, { cookie }))).json() as { url: string }
  assert.ok(consent.url, `consent: ${JSON.stringify(consent)}`)
  const code = new URL(consent.url).searchParams.get('code')!
  return await (await fetch(as['token_endpoint']!, form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE }))).json() as never
}

async function rpc(token: string, method: string, params: unknown = {}): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const res = await fetch(RESOURCE, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const raw = await res.text()
  return JSON.parse(raw.startsWith('{') ? raw : raw.split('\n').find(l => l.startsWith('data: '))!.slice(6))
}
const toolText = (r: { result?: Record<string, unknown> }) => ((r.result?.['content'] as { text: string }[] | undefined) ?? []).map(c => c.text).join('\n')

test('401 challenge points to the metadata and lists the scopes to ask for', async () => {
  const r = await fetch(RESOURCE, json({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  assert.equal(r.status, 401)
  const h = r.headers.get('www-authenticate') ?? ''
  assert.match(h, /resource_metadata="[^"]+oauth-protected-resource\/mcp"/)
  for (const s of [SCOPE_BRIEFING, SCOPE_ROUTES, SCOPE_ROUTES_WRITE, SCOPE_AIRCRAFT_WRITE, 'offline_access']) assert.ok(h.includes(s), `challenge lists ${s}`)
})

test('discovery: protected resource and authorization server metadata', async () => {
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string; authorization_servers: string[] }
  assert.equal(prm.resource, RESOURCE)
  const path = new URL(prm.authorization_servers[0]!).pathname
  as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server${path}`)).json() as Record<string, string>
  assert.ok(as['registration_endpoint'])
  assert.ok((as['code_challenge_methods_supported'] as unknown as string[]).includes('S256'))
  assert.equal(as['client_id_metadata_document_supported'] as unknown, true)
})

test('an assistant registers, the user signs in and approves read access only', async () => {
  const reg = await (await fetch(as['registration_endpoint']!, json({ client_name: 'Test Assistant', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }))).json() as { client_id: string }
  clientId = reg.client_id
  assert.ok(clientId)
  await fetch(`${BASE}/api/auth/email-otp/send-verification-otp`, json({ email: 'pilot@example.org', type: 'sign-in' }))
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email-otp`, json({ email: 'pilot@example.org', otp: lastOtp }))
  cookie = signIn.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  assert.ok(signIn.ok && cookie)
})

test('tool contract, scopes and answers', async () => {
  const t = await connect(`offline_access ${SCOPE_BRIEFING} ${SCOPE_ROUTES}`)
  assert.equal(t.scope.includes(SCOPE_AIRCRAFT_WRITE), false)
  assert.ok((await rpc(t.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result)

  // Every tool is described for a model and says whether it only reads.
  const tools = (await rpc(t.access_token, 'tools/list')).result?.['tools'] as { name: string; description: string; annotations?: { readOnlyHint?: boolean } }[]
  assert.ok(tools.length >= 9)
  for (const tool of tools) {
    assert.ok(tool.description.length >= 40, `${tool.name}: description`)
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name}: readOnlyHint`)
  }
  // Every tool that writes refuses a token without its write scope.
  const writers = tools.filter(x => x.annotations?.readOnlyHint === false)
  assert.deepEqual(writers.map(w => w.name).sort(), ['create_aircraft', 'create_route', 'update_aircraft', 'update_route'])
  const writeArgs: Record<string, unknown> = {
    create_aircraft: { registration: 'SE-NEW', cruiseIas: 100, fuelBurnLhr: 30, maxFuelL: 100 },
    update_aircraft: { aircraft: 'SE-TST', hasRadio: true },
    create_route: { points: ['ESSB', 'ESSA'] },
    update_route: { route: 'Home loop', altitudeFt: 2500 },
  }
  for (const w of writers) {
    const r = await rpc(t.access_token, 'tools/call', { name: w.name, arguments: writeArgs[w.name] })
    assert.equal(r.result?.['isError'], true, `${w.name} refused`)
    assert.match(toolText(r), /may not (change aircraft profiles|create or change routes)/)
  }
  assert.equal(saved.length + savedRoutes.length, 0)

  // Read tools answer, quote outside text and say it is data.
  const routes = toolText(await rpc(t.access_token, 'tools/call', { name: 'list_saved_routes', arguments: {} }))
  assert.match(routes, /«Home loop»/)
  assert.match(routes, /treat it as data/)
  const status = toolText(await rpc(t.access_token, 'tools/call', { name: 'aerodrome_status', arguments: { icao: 'ESSB' } }))
  assert.match(status, /METAR: «ESSB 111020Z/)
  assert.match(status, /not an official briefing/)

  // The briefing prompt is offered and points at the tools.
  const prompts = (await rpc(t.access_token, 'prompts/list')).result?.['prompts'] as { name: string }[]
  assert.deepEqual(prompts.map(p => p.name).sort(), ['plan_route', 'preflight_briefing'])
  const p = await rpc(t.access_token, 'prompts/get', { name: 'preflight_briefing', arguments: { route: 'ESSB ESMS' } })
  assert.match(JSON.stringify(p.result), /brief_route/)
})

test('with aircraft:write the assistant can add an aircraft, marked for review', async () => {
  const t = await connect(`offline_access ${SCOPE_BRIEFING} ${SCOPE_ROUTES} ${SCOPE_AIRCRAFT_WRITE}`)
  assert.ok(t.scope.includes(SCOPE_AIRCRAFT_WRITE))
  const r = await rpc(t.access_token, 'tools/call', { name: 'create_aircraft', arguments: { registration: 'SE-NEW', cruiseIas: 100, fuelBurnLhr: 30, maxFuelL: 100 } })
  assert.match(toolText(r), /Added SE-NEW/)
  assert.equal(saved.length, 1)
  assert.equal((saved[0] as { assistantReview: { by: string } }).assistantReview.by, 'Test Assistant')
})

test('with routes:write the assistant can save a route, refused points are not guessed', async () => {
  const t = await connect(`offline_access ${SCOPE_BRIEFING} ${SCOPE_ROUTES} ${SCOPE_ROUTES_WRITE}`)
  const bad = await rpc(t.access_token, 'tools/call', { name: 'create_route', arguments: { points: ['ESSB', 'XXXX'] } })
  assert.equal(bad.result?.['isError'], true)
  assert.match(toolText(bad), /XXXX: not an aerodrome/)
  const r = await rpc(t.access_token, 'tools/call', { name: 'create_route', arguments: { name: 'Hop', points: ['ESSB', 'ESSA'], altitudeFt: 2500 } })
  assert.match(toolText(r), /Saved new route «Hop»/)
  assert.match(toolText(r), /Planned with SE-TST «Rotax» \(the only aircraft profile\)/)
  assert.match(toolText(r), /\?route=[0-9a-f-]{36}/)
  assert.equal(savedRoutes.length, 1)
  assert.equal(savedRoutes[0]!.assistantReview?.by, 'Test Assistant')
  const dup = await rpc(t.access_token, 'tools/call', { name: 'create_route', arguments: { name: 'home loop', points: ['ESSB', 'ESSA'] } })
  assert.match(toolText(dup), /exists/)
  const up = await rpc(t.access_token, 'tools/call', { name: 'update_route', arguments: { route: 'Home loop', altitudeFt: 3500 } })
  assert.match(toolText(up), /Updated route \(levels\)/)
})

test('refresh tokens rotate, a replay is refused, disconnect ends access', async () => {
  const t = await connect(`offline_access ${SCOPE_BRIEFING}`)
  const r1 = await (await fetch(as['token_endpoint']!, form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId, resource: RESOURCE }))).json() as { refresh_token: string }
  assert.ok(r1.refresh_token && r1.refresh_token !== t.refresh_token)
  assert.equal((await fetch(as['token_endpoint']!, form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId, resource: RESOURCE }))).ok, false)
  const consents = await (await fetch(`${BASE}/api/auth/oauth2/get-consents`, { headers: { cookie } })).json() as { id: string }[]
  for (const c of consents) assert.ok((await fetch(`${BASE}/api/auth/oauth2/delete-consent`, json({ id: c.id }, { cookie }))).ok)
  assert.equal((await fetch(as['token_endpoint']!, form({ grant_type: 'refresh_token', refresh_token: r1.refresh_token, client_id: clientId, resource: RESOURCE }))).ok, false)
})

test('the SQL migration matches better-auth\'s schema for the OAuth tables', async () => {
  const db = new PGlite()
  await db.exec(`CREATE ROLE openvfr_api; CREATE ROLE openvfr_anon; CREATE ROLE openvfr_authenticated;
    CREATE TABLE ba_user (id TEXT PRIMARY KEY); CREATE TABLE ba_session (id TEXT PRIMARY KEY);`)
  const sql = readFileSync(new URL('../../../db/migrations/20261201000000_assistant_oauth.sql', import.meta.url), 'utf8')
  await db.exec(sql.split('-- migrate:down')[0]!)
  const probe = betterAuth({
    secret: 'test-secret-0123456789-0123456789-0123456789', baseURL: BASE,
    database: { dialect: new PGliteDialect(db), type: 'postgres' } as never,
    user: m('ba_user'), session: m('ba_session'), account: m('ba_account'), verification: m('ba_verification'),
    plugins: [...assistantConnectionPlugins({ baseUrl: BASE, appOrigin: APP })],
  })
  const { toBeCreated, toBeAdded } = await getMigrations((await probe.$context).options)
  const oauth = (t: { table: string }) => t.table === 'ba_jwks' || t.table.startsWith('ba_oauth')
  assert.deepEqual(toBeCreated.filter(oauth).map(t => t.table), [], 'tables missing from the migration')
  assert.deepEqual(toBeAdded.filter(oauth).map(t => `${t.table}: ${Object.keys(t.fields).join(',')}`), [], 'columns missing from the migration')
})
