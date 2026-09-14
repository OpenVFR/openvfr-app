/**
 * Transactional email via Brevo (https://developers.brevo.com/docs/send-a-transactional-email).
 *
 * Required env vars:
 *   BREVO_API_KEY          Brevo API key (Settings → SMTP & API → API Keys)
 *   BREVO_SENDER_EMAIL     Verified sender address (Settings → Senders)
 *   BREVO_SENDER_NAME      Optional display name, defaults to "OpenVFR"
 *
 * When BREVO_API_KEY is unset, sendEmail() logs to the console instead of
 * calling the API — this keeps local dev working without credentials.
 */

const BREVO_API_KEY      = process.env['BREVO_API_KEY'] ?? ''
const BREVO_SENDER_EMAIL = process.env['BREVO_SENDER_EMAIL'] ?? 'noreply@your-domain.example'
const BREVO_SENDER_NAME  = process.env['BREVO_SENDER_NAME'] ?? 'OpenVFR'
const BREVO_API_URL      = 'https://api.brevo.com/v3/smtp/email'

export interface SendEmailOptions {
  to: string
  subject: string
  /** Plain-text body. Provide this or `html`, not both. */
  text?: string
  /** HTML body. Provide this or `text`, not both. */
  html?: string
}

/**
 * Send a transactional email via the Brevo API.
 * Throws if the API call fails so callers can decide how to handle it.
 */
export async function sendEmail({ to, subject, text, html }: SendEmailOptions): Promise<void> {
  if (!BREVO_API_KEY) {
    console.log(`[mailer] BREVO_API_KEY not set — skipping send. Would have sent to ${to}: ${subject}`)
    return
  }

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
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
