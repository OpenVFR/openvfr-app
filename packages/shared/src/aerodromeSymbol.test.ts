import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AERODROME_SYMBOL_IDS, aerodromeIconImage, aerodromeIconRotate } from './aerodromeSymbol'
import { iosUnsafeCaseConditions } from './iosSafeExpression'

const ROOT = join(__dirname, '..', '..', '..', 'apps')

describe('aerodrome symbol images', () => {
  it('exist for web (SVG) and native (PNG)', () => {
    for (const id of [...AERODROME_SYMBOL_IDS, 'ad-airport', 'ad-heliport']) {
      expect(existsSync(join(ROOT, 'web', 'public', 'poi_icons', `${id}.svg`)), id).toBe(true)
      expect(existsSync(join(ROOT, 'native', 'assets', 'poi_icons', `${id}.png`)), id).toBe(true)
    }
    expect(existsSync(join(ROOT, 'native', 'assets', 'poi_icons', 'ad-heliport-mil.png'))).toBe(true)
  })

  // A compound condition in a multi-branch case aborted the iOS app when the
  // map style loaded (see iosSafeExpression.ts).
  it('expressions are safe for MapLibre iOS', () => {
    expect(iosUnsafeCaseConditions(aerodromeIconImage)).toEqual([])
    expect(iosUnsafeCaseConditions(aerodromeIconRotate)).toEqual([])
  })
})

describe('iosUnsafeCaseConditions', () => {
  it('flags compound conditions in a multi-branch case only', () => {
    expect(iosUnsafeCaseConditions(['case', ['!', ['has', 'a']], 'x', 'y'])).toEqual([])
    expect(iosUnsafeCaseConditions(
      ['concat', ['case', ['==', ['get', 't'], 1], 'a', ['!', ['has', 'b']], 'b', 'c']],
    )).toEqual(['$[1][3]'])
    expect(iosUnsafeCaseConditions(['case', ['has', 'a'], 'x', ['==', ['get', 'b'], 2], 'y', 'z'])).toEqual([])
  })
})
