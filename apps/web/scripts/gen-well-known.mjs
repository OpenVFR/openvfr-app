#!/usr/bin/env node
// scripts/gen-well-known.mjs
//
// Generates static /.well-known/apple-app-site-association and
// /.well-known/assetlinks.json files into public/.well-known/ at build
// time, so a static hosting deploy can serve them directly without a
// runtime proxy. Content is deployment-config (team ID, bundle ID,
// package name, cert fingerprint), not runtime-dynamic, so generating
// them once at build time is sufficient.
//
// Run via: node scripts/gen-well-known.mjs   (wired into `pnpm build`)

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OUT_DIR = join(process.cwd(), 'public', '.well-known')

const teamId      = process.env['APPLE_TEAM_ID']              ?? 'XXXXXXXXXX'
const iosBundle   = process.env['IOS_BUNDLE_ID']               ?? 'org.openvfr.app'
const androidPkg  = process.env['ANDROID_PACKAGE']             ?? 'org.openvfr.app'
const fingerprint = process.env['ANDROID_SHA256_FINGERPRINT']  ?? 'AA:BB:CC:DD'

const appleAppSiteAssociation = {
  webcredentials: {
    apps: [`${teamId}.${iosBundle}`],
  },
}

const assetlinks = [{
  relation: [
    'delegate_permission/common.handle_all_urls',
    'delegate_permission/common.get_login_creds',
  ],
  target: {
    namespace: 'android_app',
    package_name: androidPkg,
    sha256_cert_fingerprints: [fingerprint],
  },
}]

await mkdir(OUT_DIR, { recursive: true })

// apple-app-site-association has NO file extension and must be valid JSON
// served as-is (Apple's OS fetches it directly, not via a web page).
await writeFile(
  join(OUT_DIR, 'apple-app-site-association'),
  JSON.stringify(appleAppSiteAssociation, null, 2),
  'utf8',
)

await writeFile(
  join(OUT_DIR, 'assetlinks.json'),
  JSON.stringify(assetlinks, null, 2),
  'utf8',
)

console.log('[gen-well-known] Wrote public/.well-known/apple-app-site-association and assetlinks.json')
if (teamId === 'XXXXXXXXXX' || fingerprint === 'AA:BB:CC:DD') {
  console.warn(
    '[gen-well-known] WARNING: using placeholder values — set APPLE_TEAM_ID, ' +
    'IOS_BUNDLE_ID, ANDROID_PACKAGE, ANDROID_SHA256_FINGERPRINT as build ' +
    'environment variables before deploying to production.',
  )
}
