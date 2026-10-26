// app.config.js -- dynamic Expo config layered on top of app.json.
//
// app.json holds everything generic (bundle IDs, permissions, plugins).
// This file adds the maintainer-/deployment-specific EAS identifiers from
// environment variables so the repo itself stays account-agnostic:
//
//   EAS_PROJECT_ID  -- the EAS project UUID (`eas project:info`, or `eas init`
//                      to create one). Required for `eas build` / `eas update`.
//   EAS_OWNER       -- the Expo account/organisation that owns the project.
//                      Optional; only needed when the logged-in account differs
//                      from the project owner.
//
//   PASSKEY_RP_ID   -- the WebAuthn RP ID domain (the API's
//                      BETTER_AUTH_RP_ID), declared as the iOS associated
//                      domain `webcredentials:<PASSKEY_RP_ID>` so passkeys
//                      work. Defaults to openvfr.org, the maintainers' own
//                      instance; forks set their own.
//
// Self-hosters / forks: run `eas init` in apps/native, then export the
// variables above (locally in your shell or `.env`, in CI as secrets/vars).
// Plain `expo start` / `expo run:*` work without any being set.

const appJson = require('./app.json')

module.exports = ({ config }) => {
  const base = { ...appJson.expo, ...config }
  const projectId = process.env.EAS_PROJECT_ID
  const owner     = process.env.EAS_OWNER
  const rpId      = (process.env.PASSKEY_RP_ID || '').trim() || 'openvfr.org'

  return {
    ...base,
    ...(owner ? { owner } : {}),
    ios: {
      ...(base.ios ?? {}),
      associatedDomains: [`webcredentials:${rpId}`],
    },
    extra: {
      ...(base.extra ?? {}),
      ...(projectId ? { eas: { ...(base.extra?.eas ?? {}), projectId } } : {}),
    },
  }
}
