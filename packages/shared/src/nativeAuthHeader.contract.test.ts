/**
 * Tripwire: never pass `authHeaders()` into `authClient.$fetch`.
 *
 * The native auth client already sends the stored session token itself
 * (`fetchOptions.auth` in apps/native/src/utils/authClient.ts). better-fetch
 * merges per-call headers and that auth header as two plain keys that differ
 * only in case (`Authorization` / `authorization`), and `new Headers(...)`
 * joins them into `Bearer x, Bearer x`. The server's bearer plugin cannot
 * verify that value, so the request is treated as signed out: every signed-in
 * passkey call (list, add, remove) answered 401 "Unauthorized" for a whole
 * release. Plain `fetch()` calls to PostgREST etc. are fine to use authHeaders().
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const NATIVE_SRC = join(__dirname, '../../../apps/native/src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('native auth client calls', () => {
  it('Headers joins differently-cased duplicates (why the rule exists)', () => {
    const h = new Headers({ Authorization: 'Bearer a', authorization: 'Bearer a' })
    expect(h.get('authorization')).toBe('Bearer a, Bearer a')
  })

  it('no authClient.$fetch call passes authHeaders()', () => {
    const offenders: string[] = []
    for (const file of sources(NATIVE_SRC)) {
      const text = readFileSync(file, 'utf8')
      let i = text.indexOf('authClient.$fetch')
      while (i !== -1) {
        // The options object follows the call; its headers sit within a few lines.
        const window = text.slice(i, i + 600)
        const end = window.search(/\n\}\)|\n  \}\)|\n    \}\)/)
        const call = end === -1 ? window : window.slice(0, end)
        if (/authHeaders\(/.test(call)) offenders.push(file.replace(NATIVE_SRC, 'apps/native/src'))
        i = text.indexOf('authClient.$fetch', i + 1)
      }
    }
    expect(offenders).toEqual([])
  })
})
