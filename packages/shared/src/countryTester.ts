/**
 * "Become a tester for a new country" offer under the country picker in
 * Settings (web + native). Related to the website's "Help us launch your
 * country" section (openvfr-site: Cta.astro).
 */
export const COUNTRY_TESTER = {
  question: 'Missing a European country?',
  action: 'Become an official tester',
  /** Opens the user's mail app; the country goes in the message. */
  mailto:
    'mailto:waitlist@openvfr.org?subject=' + encodeURIComponent('OpenVFR country tester') +
    '&body=' + encodeURIComponent('My country: <type your country here>'),
  /** Shown when no mail app can be opened. */
  fallback: 'No mail app found. Write to waitlist@openvfr.org with your country and the subject "OpenVFR country tester".',
} as const
