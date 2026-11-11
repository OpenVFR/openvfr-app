/**
 * Transactional email. Provider is chosen by which credentials are set:
 *   1. ACS_CONNECTION_STRING -> Azure Communication Services Email (used in Azure deployments)
 *   2. BREVO_API_KEY         -> Brevo (https://developers.brevo.com/docs/send-a-transactional-email),
 *                               handy for local dev / self-hosting without Azure
 *   3. neither               -> nothing is sent; outside production the message (with the sign-in
 *                               code or link) is printed to the server console so local dev and
 *                               single-user self-hosting can sign in, in production only a warning
 *                               without content (a code must never end up in production logs)
 *
 * Azure Communication Services Email
 * (https://learn.microsoft.com/azure/communication-services/quickstarts/email/send-email).
 * Plain REST with the resource's access key (HMAC-SHA256), no SDK dependency.
 *
 * Required env vars:
 *   ACS_CONNECTION_STRING   `endpoint=https://<name>.communication.azure.com/;accesskey=<key>`
 *   EMAIL_SENDER_ADDRESS    A sender address on a verified domain of the linked Email Service
 *                           (e.g. noreply@your-domain.example). The display name is a property
 *                           of the sender username in Azure, not sent here.
 *
 * Brevo env vars:
 *   BREVO_API_KEY          API key (Settings → SMTP & API → API Keys)
 *   BREVO_SENDER_EMAIL     Verified sender address (Settings → Senders)
 *   BREVO_SENDER_NAME      Optional display name, defaults to "OpenVFR"
 */

import { createHash, createHmac } from 'node:crypto'

const API_VERSION = '2023-03-31'

export interface SendEmailOptions {
  to: string
  subject: string
  /** Plain-text body. Provide this or `html`, not both. */
  text?: string
  /** HTML body. Provide this or `text`, not both. */
  html?: string
}

export interface AcsConnection {
  /** Origin without trailing slash, e.g. https://x.communication.azure.com */
  endpoint: string
  accessKey: string
}

/** Parse `endpoint=...;accesskey=...` (the accesskey is base64: it can contain `=`). */
export function parseConnectionString(cs: string): AcsConnection {
  let endpoint = ''
  let accessKey = ''
  for (const part of cs.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim().toLowerCase()
    const v = part.slice(i + 1).trim()
    if (k === 'endpoint') endpoint = v.replace(/\/+$/, '')
    else if (k === 'accesskey') accessKey = v
  }
  if (!endpoint || !accessKey) throw new Error('ACS_CONNECTION_STRING needs endpoint= and accesskey=')
  return { endpoint, accessKey }
}

/** Headers ACS requires: x-ms-date, x-ms-content-sha256 and the HMAC Authorization. */
export function signRequest(
  conn: AcsConnection,
  method: string,
  pathAndQuery: string,
  body: string,
  date: Date = new Date(),
): Record<string, string> {
  const host = new URL(conn.endpoint).host
  const utcNow = date.toUTCString()
  const contentHash = createHash('sha256').update(body).digest('base64')
  const stringToSign = `${method.toUpperCase()}\n${pathAndQuery}\n${utcNow};${host};${contentHash}`
  const signature = createHmac('sha256', Buffer.from(conn.accessKey, 'base64')).update(stringToSign).digest('base64')
  return {
    'x-ms-date': utcNow,
    'x-ms-content-sha256': contentHash,
    Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
  }
}

/** Send via the configured provider. Throws on API failure so callers can decide how to handle it. */
export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  if (process.env['ACS_CONNECTION_STRING']) return sendViaAcs(opts)
  if (process.env['BREVO_API_KEY']) return sendViaBrevo(opts)
  logUnsent(opts)
}

/** No email provider configured: print the message outside production, only a warning in production. */
export function logUnsent(opts: SendEmailOptions, env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = console.log): void {
  if (env['NODE_ENV'] === 'production') {
    log(`[mailer] WARNING: no ACS_CONNECTION_STRING or BREVO_API_KEY set — email to ${opts.to} ("${opts.subject}") was not sent`)
    return
  }
  const body = opts.text ?? (opts.html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  log(`[mailer] no ACS_CONNECTION_STRING or BREVO_API_KEY set — not sent (dev: printed here instead)\n` +
      `  to: ${opts.to}\n  subject: ${opts.subject}\n  ${body.replace(/\n/g, '\n  ')}`)
}

async function sendViaAcs({ to, subject, text, html }: SendEmailOptions): Promise<void> {
  const connectionString = process.env['ACS_CONNECTION_STRING'] ?? ''
  const sender = process.env['EMAIL_SENDER_ADDRESS'] ?? ''
  if (!sender) throw new Error('EMAIL_SENDER_ADDRESS must be set when ACS_CONNECTION_STRING is set')

  const conn = parseConnectionString(connectionString)
  const pathAndQuery = `/emails:send?api-version=${API_VERSION}`
  const body = JSON.stringify({
    senderAddress: sender,
    recipients: { to: [{ address: to }] },
    content: { subject, ...(html ? { html } : { plainText: text ?? '' }) },
  })

  const res = await fetch(conn.endpoint + pathAndQuery, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signRequest(conn, 'POST', pathAndQuery, body) },
    body,
  })

  // 202 Accepted: ACS queues the message (delivery status is in its own logs).
  if (!res.ok) {
    const resBody = await res.text().catch(() => '')
    throw new Error(`ACS email send failed (${res.status}): ${resBody}`)
  }
}

async function sendViaBrevo({ to, subject, text, html }: SendEmailOptions): Promise<void> {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': process.env['BREVO_API_KEY'] ?? '',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: {
        name: process.env['BREVO_SENDER_NAME'] ?? 'OpenVFR',
        email: process.env['BREVO_SENDER_EMAIL'] ?? 'noreply@your-domain.example',
      },
      to: [{ email: to }],
      subject,
      ...(html ? { htmlContent: html } : { textContent: text ?? '' }),
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Brevo send failed (${res.status}): ${body}`)
  }
}
