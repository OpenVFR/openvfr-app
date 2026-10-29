import { describe, expect, it } from 'vitest'
import { parseEnvironmentLink, resolveAppEnvironment } from './appEnvironment'

describe('resolveAppEnvironment', () => {
  it('uses the saved choice', () => {
    expect(resolveAppEnvironment({ saved: 'staging', buildDefault: 'production', stagingAvailable: true })).toBe('staging')
    expect(resolveAppEnvironment({ saved: 'production', buildDefault: 'staging', stagingAvailable: true })).toBe('production')
  })
  it('falls back to the build default, then production', () => {
    expect(resolveAppEnvironment({ saved: null, buildDefault: 'staging', stagingAvailable: true })).toBe('staging')
    expect(resolveAppEnvironment({ saved: undefined, buildDefault: undefined, stagingAvailable: true })).toBe('production')
    expect(resolveAppEnvironment({ saved: 'bogus', buildDefault: 'nope', stagingAvailable: true })).toBe('production')
  })
  it('never selects staging when the build has no staging api', () => {
    expect(resolveAppEnvironment({ saved: 'staging', buildDefault: 'staging', stagingAvailable: false })).toBe('production')
  })
})

describe('parseEnvironmentLink', () => {
  it('reads openvfr://environment/<id>', () => {
    expect(parseEnvironmentLink('openvfr://environment/staging')).toBe('staging')
    expect(parseEnvironmentLink('openvfr://environment/production')).toBe('production')
    expect(parseEnvironmentLink('OPENVFR://environment/Staging/')).toBe('staging')
    expect(parseEnvironmentLink('openvfr://environment/staging?x=1')).toBe('staging')
  })
  it('ignores other links and unknown environments', () => {
    expect(parseEnvironmentLink(null)).toBeNull()
    expect(parseEnvironmentLink('openvfr://?ad=ESSB')).toBeNull()
    expect(parseEnvironmentLink('openvfr://environment/evil.example.org')).toBeNull()
    expect(parseEnvironmentLink('https://openvfr.org/environment/staging')).toBeNull()
    expect(parseEnvironmentLink('openvfr://environment/')).toBeNull()
  })
})
