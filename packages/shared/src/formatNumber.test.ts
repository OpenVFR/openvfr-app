import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { formatFt, formatNumber } from './formatNumber'

describe('formatNumber', () => {
  it('is the same on every device', () => {
    expect(formatNumber(1300)).toBe('1,300')
    expect(formatNumber(-1300)).toBe('-1,300')
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(123456789)).toBe('123,456,789')
    expect(formatNumber(1234.5)).toBe('1,234.5')
    expect(formatFt(12500)).toBe('12,500 ft')
  })
})

/** Every number a pilot reads goes through formatNumber: a bare `.toLocaleString()` follows the device ("1.300 ft" on some). */
describe('no bare toLocaleString() on numbers', () => {
  const root = join(__dirname, '..', '..', '..')
  const skip = new Set(['node_modules', 'dist', '.scratch', 'android', 'ios', '.expo', 'build'])
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'formatNumber.ts') files.push(p)
    }
  }
  for (const d of ['packages/shared/src', 'apps/web/src', 'apps/native/src', 'apps/native/modules']) {
    try { walk(join(root, d)) } catch { /* a package that is not checked out */ }
  }
  it('finds the sources', () => { expect(files.length).toBeGreaterThan(100) })
  it('has none outside dates', () => {
    const bad: string[] = []
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!/\.toLocaleString\(\s*\)/.test(line)) return
        if (/new Date\(|Date\.now\(\)/.test(line)) return           // a date and time: the device's own format is right for those
        bad.push(`${relative(root, f)}:${i + 1}: ${line.trim().slice(0, 100)}`)
      })
    }
    expect(bad, `use formatNumber() from @open-vfr/shared/formatNumber:\n${bad.join('\n')}`).toEqual([])
  })
})
