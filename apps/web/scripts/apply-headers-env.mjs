#!/usr/bin/env node
// scripts/apply-headers-env.mjs
//
// Rewrites the CSP `connect-src` in dist/_headers to the API and tile
// origins this build was made for, run after `vite build` (wired into
// `pnpm build`).
//
// public/_headers lists the official production origins. A build that talks
// to another backend (the staging Worker: VITE_API_BASE_URL=https://api-staging...)
// would otherwise be blocked by its own CSP ("Refused to connect"). The
// production origin is replaced, not added to, so a staging build does not
// allow calls to production.
//
// No effect when the variables are unset or equal the defaults (production,
// self-hosters serving the API from the same origin).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const file = join(dist, '_headers')
if (!existsSync(file)) {
  console.log('apply-headers-env: no dist/_headers, nothing to do')
  process.exit(0)
}

const originOf = (name) => {
  const v = (process.env[name] ?? '').trim()
  if (!v || v.startsWith('/')) return null // unset or same-origin path
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)')
    return u.origin
  } catch {
    console.error(`apply-headers-env: ${name}="${v}" is not an absolute http(s) URL`)
    process.exit(1)
  }
}

const REPLACE = [
  ['https://api.openvfr.org', originOf('VITE_API_BASE_URL')],
  ['https://tiles.openvfr.org', originOf('VITE_TILES_BASE_URL')],
]

let text = readFileSync(file, 'utf8')
for (const [from, to] of REPLACE) {
  if (!to || to === from) continue
  if (!text.includes(from)) {
    console.error(`apply-headers-env: ${from} not found in dist/_headers (did public/_headers change?)`)
    process.exit(1)
  }
  text = text.split(from).join(to)
  console.log(`apply-headers-env: connect-src ${from} -> ${to}`)
}
writeFileSync(file, text)
