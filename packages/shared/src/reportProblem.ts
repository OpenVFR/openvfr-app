// packages/shared/src/reportProblem.ts
//
// "Report a problem" for aerodrome data: a mailto: link that opens the user's
// mail app with the airfield and the versions they saw already filled in, so a
// report can be checked against the exact data it is about. Reports are read
// by a person and turned into curation candidates by hand (nothing a user
// sends is published); see docs/curation.md in openvfr-infra.

export const REPORT_PROBLEM_EMAIL = 'report-issue@openvfr.org'

export interface ReportProblemContext {
  icao: string
  name?: string | null
  /** App version name, e.g. "0.9.0". */
  appVersion?: string | null
  /** "web" | "android" | "ios". */
  platform?: string | null
  /** The tile manifest's `generated_at` (ISO): which data the user was looking at. */
  dataGeneratedAt?: string | null
}

/** `mailto:` URL with subject and a body template; every value is percent-encoded. */
export function buildReportProblemMailto(ctx: ReportProblemContext): string {
  const icao = ctx.icao.trim().toUpperCase()
  const name = ctx.name?.trim()
  const data = ctx.dataGeneratedAt?.slice(0, 10)
  const lines = [
    `Aerodrome: ${icao}${name ? ` (${name})` : ''}`,
    `App: ${[ctx.platform, ctx.appVersion].filter(Boolean).join(' ') || 'unknown'}`,
    `Data: ${data || 'unknown'}`,
    '',
    'What is wrong or missing:',
    '',
    '',
    'Correct value and where it is published (AIP page, website, link):',
    '',
  ]
  const q = `subject=${encodeURIComponent(`Airfield data: ${icao}`)}&body=${encodeURIComponent(lines.join('\n'))}`
  return `mailto:${REPORT_PROBLEM_EMAIL}?${q}`
}
