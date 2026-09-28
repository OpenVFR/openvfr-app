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
// Self-hosters / forks: run `eas init` in apps/native, then export the two
// variables above (locally in your shell or `.env`, in CI as secrets/vars).
// Plain `expo start` / `expo run:*` work without either being set.

const appJson = require('./app.json')

module.exports = ({ config }) => {
  const base = { ...appJson.expo, ...config }
  const projectId = process.env.EAS_PROJECT_ID
  const owner     = process.env.EAS_OWNER

  return {
    ...base,
    ...(owner ? { owner } : {}),
    extra: {
      ...(base.extra ?? {}),
      ...(projectId ? { eas: { ...(base.extra?.eas ?? {}), projectId } } : {}),
    },
  }
}
