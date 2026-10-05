/**
 * Fails when the resolved Expo config drifts from the permission policy:
 *  - android.permission.ACTIVITY_RECOGNITION must stay blocked (expo-sensors
 *    declares it for the pedometer; the barometer does not need it, and it
 *    would add a runtime prompt and Play review scrutiny).
 *  - android.permission.ACCESS_BACKGROUND_LOCATION must stay blocked.
 *  - The expo-sensors plugin must set a motionPermission string, otherwise
 *    iOS has no NSMotionUsageDescription and reading the barometer fails.
 *
 * Run from apps/native: `node scripts/check-permissions.mjs`.
 */
import { execSync } from 'node:child_process'

const config = JSON.parse(execSync('npx expo config --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
const errors = []

const blocked = config.android?.blockedPermissions ?? []
for (const perm of ['android.permission.ACTIVITY_RECOGNITION', 'android.permission.ACCESS_BACKGROUND_LOCATION']) {
  if (!blocked.includes(perm)) errors.push(`android.blockedPermissions must include ${perm}`)
}

const sensors = (config.plugins ?? []).find((p) => Array.isArray(p) && p[0] === 'expo-sensors')
if (!sensors || typeof sensors[1]?.motionPermission !== 'string' || !sensors[1].motionPermission.trim()) {
  errors.push('expo-sensors plugin must set a non-empty motionPermission string (iOS NSMotionUsageDescription)')
}

if (errors.length) {
  console.error('Permission policy check failed:\n - ' + errors.join('\n - '))
  process.exit(1)
}
console.log('Permission policy check passed.')
