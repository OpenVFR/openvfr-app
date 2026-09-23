/**
 * open-vfr API server — Hono + Node.js
 *
 * Single endpoint: POST /api/poh-extract  →  text/event-stream (SSE)
 *
 * Flow:
 *   1. Receive PDF via multipart/form-data (field: "file")
 *   2. Write to a temp file, upload to Azure OpenAI Files API (purpose: user_data)
 *   3. SSE: {"stage":"uploading"}
 *   4. Poll until file.status === "processed"
 *   5. SSE: {"stage":"processing"}
 *   6. Call responses.create with the file_id
 *   7. SSE: {"stage":"extracting"}
 *   8. Parse JSON from output_text, stream result
 *   9. SSE: {"result":{...}}  or  {"error":"...","retryAfterSeconds?:N}
 *  10. Always clean up: delete temp file + remote file
 *
 * Required env vars:
 *   AZURE_OPENAI_ENDPOINT    e.g. https://<your-resource>.services.ai.azure.com/
 *   AZURE_OPENAI_API_KEY     Azure AI Services key
 *   AZURE_OPENAI_DEPLOYMENT  Deployment name (e.g. gpt-4o)
 * PORT defaults to 5200.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import OpenAI, { toFile } from 'openai'
import { writeFileSync, createReadStream, unlinkSync } from 'node:fs'
import { trafficConfig, registerClient, startTrafficPoller, getLatestBatch, touchActivity } from './traffic'
import { startOgnRelay } from './ognTraffic'
import { startNotamPoller, getNotamsForIcao, getRegionalNotams, getAerodromeNotamTexts } from './notam'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHmac } from 'node:crypto'
import { auth } from './auth'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const AZURE_ENDPOINT   = process.env['AZURE_OPENAI_ENDPOINT']   ?? ''
const AZURE_API_KEY    = process.env['AZURE_OPENAI_API_KEY']    ?? ''
const AZURE_DEPLOYMENT = process.env['AZURE_OPENAI_DEPLOYMENT'] ?? 'gpt-4o'
const PORT             = Number(process.env['PORT'] ?? 5200)
const MAX_FILE_MB      = 50

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an expert in extracting information from Pilot Operating Handbooks (POH) for use in creating aircraft profiles in EFB / VFR apps.

Search the ENTIRE attached PDF thoroughly — including all tables, performance charts, limitations sections, and appendices — to find the values below.

ACCURACY RULE: Only include a value if you found it explicitly stated in the document. Do not invent numbers. However, DO include values even if the label wording differs from below — use the equivalent data. Do not substitute a value from a DIFFERENT concept just because the wording sounds similar (e.g. a pre-flight/take-off minimum fuel requirement is NOT the same thing as a post-flight/landing fuel reserve — confirm which one the document is actually describing before assigning it to a field, and omit the field if unsure).

Return ONLY a raw JSON object with any of these keys you found (omit keys not found):

- "name": aircraft model name (string, e.g. "Cessna 172S Skyhawk")
- "icaoType": ICAO type designator (string, e.g. "C172", "GYRO", "GLID")
- "cruiseAltFt": typical cruise / operating altitude in feet — look for VH, cruise altitude, normal operating altitude. Convert from metres (×3.281) if needed.
- "cruiseIas": typical cruise IAS in knots — look for VH, cruise speed, normal cruise, recommended cruise. Convert from km/h (×0.5400) or mph (×0.8690).
- "fuelBurnLhr": cruise fuel consumption in L/hr — look for fuel flow, consumption at cruise power. Convert from US gal/hr (×3.785) or UK gal/hr (×4.546).
- "maxFuelL": total USABLE fuel capacity in litres for the STANDARD (non-optional) tank — total capacity minus unusable fuel. If only total capacity and unusable fuel are given, compute usable = total − unusable. Use the standard tank, not optional/auxiliary tanks. Convert from US gal (×3.785) or UK gal (×4.546).
- "taxiFuelL": taxi / engine warmup fuel in litres — look for ground run, taxi allowance, warm-up fuel.
- "landingFuelL": fixed fuel reserve that must remain in the tank AT LANDING/AFTER the flight, in litres — look for "final reserve", "landing reserve", "minimum fuel at destination", "reserve fuel", VFR reserve, 45-minute reserve. Convert from US gal (×3.785) or UK gal (×4.546).
  DO NOT confuse this with a pre-flight/take-off minimum fuel requirement (e.g. "minimum fuel for take-off", "minimum fuel quantity before flight", a pre-flight checklist minimum, or a fuel-gauge placard minimum). Those specify how much fuel must be aboard BEFORE departure — a completely different concept from a reserve that must remain AFTER landing. If the document only states a pre-flight/take-off minimum and never explicitly states a post-flight/landing reserve, omit this key entirely rather than reusing the take-off number.
- "serviceCeilingFt": service ceiling or maximum operating altitude in feet. Convert from metres (×3.281).
- "rocSlFpm": best rate of climb at sea level in fpm — look for Vy climb rate, ROC, rate of climb. Convert from m/s (×197) or m/min (×3.281).
- "climbIas": best rate of climb speed (Vy) in knots. Convert from km/h (×0.5400) or mph (×0.8690).
- "climbFuelLhr": fuel burn during climb in L/hr. Convert as above.
- "descentFpm": typical descent rate in fpm, positive value. Convert from m/s (×197) or m/min (×3.281).
- "descentIas": typical descent IAS in knots. Convert from km/h or mph.
- "descentFuelLhr": fuel burn during descent in L/hr.
- "bestGlideIas": best glide speed in knots (gliders / TMG / autogyros only). Convert if needed.
- "glideRatio": best glide ratio as a number e.g. 30 for 30:1 (gliders / TMG / autogyros only).

Output ONLY the JSON object. No markdown, no explanation, no code fences.`

// ---------------------------------------------------------------------------
// OpenAI client pointed at the AI Foundry project-scoped /v1 endpoint.
// This endpoint is OpenAI-API-compatible — it does NOT accept api-version.
// Auth via "api-key" header (same key as Azure AI Services).
// ---------------------------------------------------------------------------
let openai: OpenAI | null = null
if (AZURE_ENDPOINT && AZURE_API_KEY) {
  const baseURL = AZURE_ENDPOINT.replace(/\/$/, '') + '/openai/v1'
  openai = new OpenAI({
    baseURL,
    apiKey: AZURE_API_KEY,
    defaultHeaders: { 'api-key': AZURE_API_KEY },
  })
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))

// ---------------------------------------------------------------------------
// /api/version — force-update gate
//
// Native app checks this on launch (see apps/native/src/hooks/useForceUpdate.ts)
// and compares its own build version against APP_MIN_VERSION. If the running
// app is older, it triggers a *blocking* platform update flow (Play Core
// IMMEDIATE on Android, forced App Store alert on iOS) instead of a custom
// modal -- both platforms' accepted mechanism for this, not a bespoke one.
//
// Bump APP_MIN_VERSION in the same deploy that ships a backend change the
// old app binary can no longer talk to (breaking API/schema change) --
// this endpoint has no way to know that on its own, it just echoes config.
// Leave unset (defaults to '0.0.0') when no client compatibility break is
// in flight -- that value is always satisfied, so the check is a no-op.
// ---------------------------------------------------------------------------
app.get('/api/version', (c) => c.json({
  minVersion: process.env['APP_MIN_VERSION'] ?? '0.0.0',
}))

// ---------------------------------------------------------------------------
// /.well-known — required for native passkeys
//
// SUPERSEDED when the frontend is deployed as static hosting on its own
// origin (see apps/web/scripts/gen-well-known.mjs): in that topology these
// paths are generated as static files at build time instead, since the
// passkey associated domain no longer proxies to this API at all. These
// handlers are left in place harmlessly as a reference implementation /
// fallback for any deployment that serves this API and the frontend from
// the same origin instead.
//
// iOS: apple-app-site-association tells the OS that this domain is associated
//   with the app's bundle ID so the platform authenticator accepts passkey
//   assertions from it.  Set APPLE_TEAM_ID in .env.prod.
//
// Android: assetlinks.json associates the domain with your APK signing cert.
//   Set ANDROID_PACKAGE and ANDROID_SHA256_FINGERPRINT in .env.prod.
//   Get the fingerprint with:
//     keytool -list -v -keystore release.keystore
//   or from Play Console → Setup → App integrity → SHA-256 certificate fingerprint.
// ---------------------------------------------------------------------------
app.get('/.well-known/apple-app-site-association', (c) => {
  const teamId = process.env['APPLE_TEAM_ID'] ?? 'XXXXXXXXXX'
  const bundle = process.env['IOS_BUNDLE_ID']  ?? 'org.openvfr.app'
  return c.json({
    webcredentials: {
      apps: [`${teamId}.${bundle}`],
    },
  })
})

app.get('/.well-known/assetlinks.json', (c) => {
  const pkg         = process.env['ANDROID_PACKAGE']            ?? 'org.openvfr.app'
  const fingerprint = process.env['ANDROID_SHA256_FINGERPRINT'] ?? 'AA:BB:CC:DD'
  return c.json([{
    relation: [
      'delegate_permission/common.handle_all_urls',
      'delegate_permission/common.get_login_creds',
    ],
    target: {
      namespace:               'android_app',
      package_name:            pkg,
      sha256_cert_fingerprints: [fingerprint],
    },
  }])
})

// ---------------------------------------------------------------------------
// Auth token endpoint — issues a short-lived PostgREST JWT.
// Must be registered BEFORE the catch-all /api/auth/* handler.
// ---------------------------------------------------------------------------
app.get('/api/auth/token', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: 'Unauthenticated' }, 401)

  const secret = process.env['BETTER_AUTH_SECRET']!
  const now    = Math.floor(Date.now() / 1000)
  const exp    = now + 3600 // 1 hour

  // Build a minimal HS256 JWT that PostgREST will accept.
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    sub:  session.user.id,
    role: 'authenticated',
    email: session.user.email,
    iat:  now,
    exp,
  })).toString('base64url')
  const sig = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url')
  const jwt = `${header}.${payload}.${sig}`

  return c.json({ jwt, expiresAt: exp })
})

// ---------------------------------------------------------------------------
// better-auth — catch-all for all /api/auth/* routes.
// Registered after /api/auth/token so that endpoint takes priority.
// ---------------------------------------------------------------------------
app.all('/api/auth/*', (c) => auth.handler(c.req.raw))

// ---------------------------------------------------------------------------
// Shared auth guard — the native app requires login, so every /api/* data
// endpoint (aviation data, weather, NOTAM, traffic, POH) requires a valid
// session. Only /health and /.well-known/* (platform verification) and the
// /api/auth/* routes themselves stay open. Works uniformly for native
// (Authorization bearer header, via the `bearer` better-auth plugin) and web
// (session cookie).
// ---------------------------------------------------------------------------
async function requireSession(c: import('hono').Context): Promise<{ id: string } | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  return session?.user ?? null
}

// ---------------------------------------------------------------------------
// POH extraction rate limiting — each call costs real Azure OpenAI money, so
// gate behind auth and cap per-user usage. In-memory sliding window is fine
// for a single-instance server; move to a shared store (Redis, DB) if this
// server ever scales to multiple instances.
// ---------------------------------------------------------------------------
const POH_HOURLY_LIMIT = Number(process.env['POH_HOURLY_LIMIT'] ?? 5)
const POH_DAILY_LIMIT   = Number(process.env['POH_DAILY_LIMIT']   ?? 20)
const HOUR_MS = 60 * 60 * 1000
const DAY_MS  = 24 * HOUR_MS

const pohUsage = new Map<string, number[]>() // userId -> timestamps (ms) of attempts, last 24h

function checkPohRateLimit(userId: string): { allowed: true } | { allowed: false, retryAfterSeconds: number, reason: string } {
  const now = Date.now()
  const timestamps = (pohUsage.get(userId) ?? []).filter(t => now - t < DAY_MS)

  const lastHour = timestamps.filter(t => now - t < HOUR_MS)
  if (lastHour.length >= POH_HOURLY_LIMIT) {
    const oldestInWindow = Math.min(...lastHour)
    const retryAfterSeconds = Math.ceil((oldestInWindow + HOUR_MS - now) / 1000)
    return { allowed: false, retryAfterSeconds, reason: `Hourly limit of ${POH_HOURLY_LIMIT} POH extractions reached.` }
  }
  if (timestamps.length >= POH_DAILY_LIMIT) {
    const oldestInWindow = Math.min(...timestamps)
    const retryAfterSeconds = Math.ceil((oldestInWindow + DAY_MS - now) / 1000)
    return { allowed: false, retryAfterSeconds, reason: `Daily limit of ${POH_DAILY_LIMIT} POH extractions reached.` }
  }

  timestamps.push(now)
  pohUsage.set(userId, timestamps)
  return { allowed: true }
}

app.post('/api/poh-extract', async (c) => {
  if (!openai) {
    return c.json(
      { error: 'Azure OpenAI is not configured. Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY.' },
      503,
    )
  }

  // ── Require an authenticated session — every call costs real money via
  // Azure OpenAI, this endpoint must never be reachable anonymously.
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) {
    return c.json({ error: 'Authentication required.' }, 401)
  }

  const rateCheck = checkPohRateLimit(session.user.id)
  if (!rateCheck.allowed) {
    return c.json(
      { error: `${rateCheck.reason} Try again in ${Math.ceil(rateCheck.retryAfterSeconds / 60)} min.`, retryAfterSeconds: rateCheck.retryAfterSeconds },
      429,
    )
  }

  // ── Parse multipart body ────────────────────────────────────────────────
  let file: File | string | undefined
  try {
    const body = await c.req.parseBody()
    file = body['file']
  } catch {
    return c.json({ error: 'Failed to parse request body.' }, 400)
  }

  if (!file || typeof file === 'string') {
    return c.json({ error: 'No PDF file uploaded. Send a "file" field in multipart/form-data.' }, 400)
  }

  const fileMb = file.size / (1024 * 1024)
  if (fileMb > MAX_FILE_MB) {
    return c.json(
      { error: `File is ${fileMb.toFixed(1)} MB — maximum is ${MAX_FILE_MB} MB.` },
      413,
    )
  }

  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    return c.json({ error: 'Only PDF files are accepted.' }, 400)
  }

  const tmpPath = join(tmpdir(), `poh-${randomUUID()}.pdf`)
  writeFileSync(tmpPath, Buffer.from(await file.arrayBuffer()))
  const fileName = file.name

  // ── Stream SSE back to client ───────────────────────────────────────────
  return streamSSE(c, async (stream) => {
    let uploadedFileId: string | null = null

    try {
      // 1. Upload PDF to Files API
      await stream.writeSSE({ data: JSON.stringify({ stage: 'uploading' }) })
      const uploadedFile = await openai!.files.create({
        file: await toFile(createReadStream(tmpPath), fileName, { type: 'application/pdf' }),
        purpose: 'assistants',
      })
      uploadedFileId = uploadedFile.id
      console.log(`[poh-extract] Uploaded ${uploadedFileId} (${fileMb.toFixed(1)} MB)`)

      // 2. With purpose='assistants' files are processed synchronously — no polling needed.
      // Emit 'processing' stage for UI consistency then move straight to extraction.
      await stream.writeSSE({ data: JSON.stringify({ stage: 'processing' }) })

      // 3. Run the model
      await stream.writeSSE({ data: JSON.stringify({ stage: 'extracting' }) })
      // Reasoning-family models (o-series, some gpt-5.x variants) reject an
      // explicit `temperature` param outright (400) since it's fixed
      // internally. Rather than hardcode a fragile model-name allowlist,
      // try with temperature first and retry once without it on that
      // specific error.
      const buildRequest = (withTemperature: boolean) => ({
        model: AZURE_DEPLOYMENT,
        ...(withTemperature ? { temperature: 0 } : {}),
        input: [
          {
            type: 'message' as const,
            role: 'user' as const,
            content: [
              {
                type: 'input_file' as const,
                file_id: uploadedFileId!,
              },
              {
                type: 'input_text' as const,
                text: SYSTEM_PROMPT + '\n\nExtract all performance data from the attached POH/AFM PDF now.',
              },
            ],
          },
        ],
      })

      let response
      try {
        response = await openai!.responses.create(buildRequest(true))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("'temperature' is not supported")) {
          console.log('[poh-extract] Model rejects temperature param — retrying without it')
          response = await openai!.responses.create(buildRequest(false))
        } else {
          throw err
        }
      }

      // Extract output text — try SDK convenience property first, then walk the
      // output array manually (the project-scoped endpoint nests it differently).
      let rawText = response.output_text ?? ''
      if (!rawText) {
        for (const item of (response.output ?? [])) {
          const content = (item as { content?: Array<{ type: string; text?: string }> }).content ?? []
          for (const block of content) {
            if (block.type === 'output_text' && block.text) { rawText = block.text; break }
          }
          if (rawText) break
        }
      }
      console.log(`[poh-extract] Raw output (${rawText.length} chars): ${rawText.slice(0, 1000)}`)

      const cleaned = rawText
        .replace(/^```[a-z]*\n?/i, '')
        .replace(/\n?```$/i, '')
        .trim()

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(cleaned) as Record<string, unknown>
      } catch {
        console.error('[poh-extract] Non-JSON response:', cleaned.slice(0, 400))
        throw new Error('Model returned a response that could not be parsed as JSON. Try again.')
      }

      await stream.writeSSE({ data: JSON.stringify({ result: parsed }) })

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)

      // Dump everything the OpenAI SDK gives us — err.message alone often
      // truncates the actual API error body (e.g. "400 There was an issue..."
      // hides the real validation detail). APIError instances carry status,
      // code, and the raw response body under `.error`.
      const sdkErr = err as {
        status?: number
        code?: string
        type?: string
        error?: unknown
        headers?: unknown
        request_id?: string
      }
      console.error('[poh-extract] Full error detail:', {
        message: msg,
        status: sdkErr?.status,
        code: sdkErr?.code,
        type: sdkErr?.type,
        request_id: sdkErr?.request_id,
        body: sdkErr?.error,
        stack: err instanceof Error ? err.stack : undefined,
      })

      if (msg.includes('401') || msg.includes('AuthenticationFailed') || msg.includes('InvalidApiKey')) {
        console.error('[poh-extract] Auth error:', msg)
        await stream.writeSSE({ data: JSON.stringify({ error: 'Azure OpenAI API key is invalid. Check server configuration.' }) })
        return
      }
      if (msg.includes('429') || msg.includes('TooManyRequests') || msg.includes('RateLimitReached')) {
        const retryMatch = /retry.?after[:\s]+(\d+)/i.exec(msg)
        const retrySecs = retryMatch ? parseInt(retryMatch[1], 10) + 5 : 65
        console.error('[poh-extract] Rate limit (retrySecs=%d):', retrySecs, msg)
        await stream.writeSSE({ data: JSON.stringify({
          error: `Azure OpenAI rate limit reached. Retry in ${retrySecs} seconds.`,
          retryAfterSeconds: retrySecs,
        }) })
        return
      }

      console.error('[poh-extract] Error:', msg)
      await stream.writeSSE({ data: JSON.stringify({ error: msg }) })

    } finally {
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      if (uploadedFileId) {
        try { await openai!.files.delete(uploadedFileId) } catch { /* ignore */ }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Traffic — GET /api/traffic/config
// ---------------------------------------------------------------------------
app.get('/api/traffic/config', async (c) => {
  if (!(await requireSession(c))) return c.json({ error: 'Authentication required.' }, 401)
  return c.json(trafficConfig)
})

// ── Traffic — GET /api/traffic/latest (single snapshot, native app polling)
//
// touchActivity() marks this as a live consumer heartbeat — the idle-gated
// poll loop (server/src/traffic.ts) treats a recent /latest request the same
// as an open SSE connection, restarting/keeping the poller alive for native
// clients which have no persistent connection of their own.
app.get('/api/traffic/latest', async (c) => {
  if (!(await requireSession(c))) return c.json({ error: 'Authentication required.' }, 401)
  touchActivity()
  const batch = getLatestBatch()
  if (!batch) return c.json({ polledAt: 0, states: [] })
  return c.json(batch)
})

// ---------------------------------------------------------------------------
// Traffic — GET /api/traffic/stream  (SSE, long-lived)
//
// Each client receives events of the form:
//   data: {"polledAt":N,"states":[...]}
//
// The connection is kept alive by a 30-second "heartbeat" comment so proxies
// (nginx, Cloudflare) don't close idle SSE connections.
// ---------------------------------------------------------------------------
app.get('/api/traffic/stream', async (c) => {
  if (!(await requireSession(c))) return c.json({ error: 'Authentication required.' }, 401)
  if (!trafficConfig.available) {
    return c.json({ error: 'OpenSky credentials not configured on this server.' }, 503)
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const enc = new TextEncoder()

  const write = (data: string): void => {
    writer.write(enc.encode(`data: ${data}\n\n`)).catch(() => cleanup())
  }

  const unregister = registerClient(write)

  // Heartbeat keeps nginx / intermediary proxies from closing the connection.
  const heartbeatInterval = setInterval(() => {
    writer.write(enc.encode(': heartbeat\n\n')).catch(() => cleanup())
  }, 30_000)

  function cleanup(): void {
    clearInterval(heartbeatInterval)
    unregister()
    writer.close().catch(() => {})
  }

  // Detect client disconnect: when the request is aborted, clean up.
  c.req.raw.signal.addEventListener('abort', cleanup, { once: true })

  return new Response(readable, {
    headers: {
      'Content-Type':  'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',  // disable nginx proxy buffering
    },
  })
})

// ---------------------------------------------------------------------------
// Weather — GET /api/weather?icao=ESSA
// Proxies to aviationweather.gov (free, no API key required).
// Returns { metar: string | null, taf: string | null }.
// Server-side 5-minute cache keyed by uppercase ICAO.
// Client IP is never forwarded upstream.
// ---------------------------------------------------------------------------
const wxCache = new Map<string, { data: { metar: string | null; taf: string | null }; expiresAt: number }>()
const WX_TTL_MS = 5 * 60 * 1000

app.get('/api/weather', async (c) => {
  if (!(await requireSession(c))) return c.json({ error: 'Authentication required.' }, 401)
  const icao = (c.req.query('icao') ?? '').toUpperCase().trim()
  if (!/^[A-Z]{4}$/.test(icao)) return c.json({ error: 'Invalid ICAO identifier' }, 400)

  const cached = wxCache.get(icao)
  if (cached && Date.now() < cached.expiresAt) return c.json(cached.data)

  const headers = { 'User-Agent': 'open-vfr/1.0', 'Accept': 'application/json' }
  try {
    const [metarResp, tafResp] = await Promise.all([
      fetch(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=3`, { headers }),
      fetch(`https://aviationweather.gov/api/data/taf?ids=${icao}&format=json`, { headers }),
    ])

    let metar: string | null = null
    let taf: string | null = null

    if (metarResp.ok) {
      const text = await metarResp.text()
      if (text.trim()) {
        try {
          const arr = JSON.parse(text) as { rawOb?: string }[]
          metar = arr[0]?.rawOb ?? null
        } catch (parseErr) {
          console.error(`[weather] METAR JSON parse failed for ${icao}:`, parseErr)
        }
      }
    }
    if (tafResp.ok) {
      const text = await tafResp.text()
      if (text.trim()) {
        try {
          const arr = JSON.parse(text) as { rawTAF?: string }[]
          taf = arr[0]?.rawTAF ?? null
        } catch (parseErr) {
          console.error(`[weather] TAF JSON parse failed for ${icao}:`, parseErr)
        }
      }
    }

    const data = { metar, taf }
    wxCache.set(icao, { data, expiresAt: Date.now() + WX_TTL_MS })
    return c.json(data)
  } catch (err) {
    console.error('[weather] fetch failed:', err)
    return c.json({ error: 'Weather service unavailable' }, 502)
  }
})

// ---------------------------------------------------------------------------
// NOTAM — GET /api/notam?icao=ESSA
//
// Backed by ./notam.ts's shared NMS-API (FAA NOTAM Management Service)
// poller/cache. This handler does NOT call NMS directly — NMS-API's
// production rate limit (1 delta pull / 3 min, ACCOUNT-WIDE not per-user)
// makes a live-call-per-request design unworkable. See notam.ts header for
// full design rationale (bootstrap vs. delta polling, classification
// filtering, why /notams/il is not used).
//
// Replaces the legacy external-api.faa.gov/notamapi/v1 integration (static
// client_id/client_secret headers, live call per request, per-user rate
// limit) — that endpoint had no documented rate limit at all, which no
// longer applies now that NMS-API imposes an explicit, tight, account-wide
// one. Fallback to aviationweather.gov (North American identifiers) is also
// dropped: this app only serves Swedish aerodromes (se-aerodromes.geojson),
// so that branch was unreachable in practice; NMS-API covers ESSA etc.
// directly under INTERNATIONAL classification.
// ---------------------------------------------------------------------------
app.get('/api/notam', async (c) => {
  const user = await requireSession(c)
  if (!user) return c.json({ error: 'Authentication required.' }, 401)
  const icao = (c.req.query('icao') ?? '').toUpperCase().trim()
  if (!/^[A-Z]{4}$/.test(icao)) return c.json({ error: 'Invalid ICAO identifier' }, 400)

  return c.json(getNotamsForIcao(icao))
})

// ---------------------------------------------------------------------------
// NOTAM (regional/FIR-wide) — GET /api/notam/regional
// Restricted/danger areas, navaid outages, AIRAC amendments, military
// notices, etc. filed against the whole Sweden FIR (ESAA) rather than any
// single airport ICAO — see notam.ts's getRegionalNotams() for the full
// rationale. Client-side consumption (map layer / dedicated panel) is not
// yet built — see docs/todo.md — this endpoint exists so the data is
// already reachable once that UI work happens, without another server change.
// ---------------------------------------------------------------------------
app.get('/api/notam/regional', async (c) => {
  const user = await requireSession(c)
  if (!user) return c.json({ error: 'Authentication required.' }, 401)
  return c.json(getRegionalNotams())
})

// ---------------------------------------------------------------------------
// NOTAM (bulk per-aerodrome texts) — GET /api/notam/aerodrome-texts
// { [icao]: string[] } for every allow-listed airport with at least one
// currently-active NOTAM. Pure in-memory cache read (see notam.ts's
// getAerodromeNotamTexts() doc comment) — no external NMS-API call at
// request time, so no additional per-user rate limit beyond auth, same as
// its /api/notam and /api/notam/regional siblings above. Powers the map's
// towered-airport ATC status ring: client applies its own keyword-based
// ATC-closed / hours-changed heuristics (@open-vfr/shared/atcStatus) against
// this in one shot instead of one /api/notam request per towered airport.
// ---------------------------------------------------------------------------
app.get('/api/notam/aerodrome-texts', async (c) => {
  const user = await requireSession(c)
  if (!user) return c.json({ error: 'Authentication required.' }, 401)
  return c.json(getAerodromeNotamTexts())
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`open-vfr API server listening on port ${PORT}`)
  if (!AZURE_ENDPOINT || !AZURE_API_KEY) {
    console.warn('WARNING: Azure OpenAI not configured — /api/poh-extract will return 503')
  }
  startTrafficPoller()
  startOgnRelay()
  startNotamPoller()
})
