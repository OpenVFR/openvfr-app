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

// Optional tile host key (EXPO_PUBLIC_TILE_KEY, src/config.ts). The app ignores a malformed one with only a console warning,
// i.e. a release build would run keyless and every tile request would get 403: fail the build instead. Same pattern as
// parseTileKey in packages/shared/src/tileKey.ts (16-128 characters of A-Z a-z 0-9 _ -; the app trims the value first).
const tileKey = (process.env.EXPO_PUBLIC_TILE_KEY || '').trim()
if (tileKey && !/^[A-Za-z0-9_-]{16,128}$/.test(tileKey)) {
  throw new Error(`EXPO_PUBLIC_TILE_KEY is malformed (${tileKey.length} characters): it must be 16-128 characters of A-Z a-z 0-9 _ -`)
}

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
