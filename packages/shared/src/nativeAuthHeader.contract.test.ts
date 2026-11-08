/**
 * Tripwire: never use `authHeaders()` in a file that calls `authClient.$fetch`.
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

  it('no file that uses authClient.$fetch also uses authHeaders()', () => {
    // File level on purpose: the original bug built the headers first
    // (`const headers = auth ? await authHeaders() : {}`) and passed the variable,
    // which a per-call text scan misses. Plain fetch() callers may use authHeaders().
    const offenders = sources(NATIVE_SRC)
      .filter((file) => {
        const text = readFileSync(file, 'utf8')
        return text.includes('authClient.$fetch') && /\bauthHeaders\b/.test(text)
      })
      .map((file) => file.replace(NATIVE_SRC, 'apps/native/src'))
    expect(offenders).toEqual([])
  })
})
