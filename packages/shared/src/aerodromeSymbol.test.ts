import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AERODROME_SYMBOL_IDS } from './aerodromeSymbol'

const ROOT = join(__dirname, '..', '..', '..', 'apps')

describe('aerodrome symbol images', () => {
  it('exist for web (SVG) and native (PNG)', () => {
    for (const id of [...AERODROME_SYMBOL_IDS, 'ad-airport', 'ad-heliport']) {
      expect(existsSync(join(ROOT, 'web', 'public', 'poi_icons', `${id}.svg`)), id).toBe(true)
      expect(existsSync(join(ROOT, 'native', 'assets', 'poi_icons', `${id}.png`)), id).toBe(true)
    }
    expect(existsSync(join(ROOT, 'native', 'assets', 'poi_icons', 'ad-heliport-mil.png'))).toBe(true)
  })
})
