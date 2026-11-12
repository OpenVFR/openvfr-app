import { describe, it, expect } from 'vitest'
import { unreviewedActive, setUnreviewedPreference, getUnreviewedPreference, unreviewedShown } from './unreviewedCurated'
import { setAdminSession } from './adminAccess'

describe('unreviewed curated data', () => {
  it('needs an admin AND the preference', () => {
    expect(unreviewedActive(false, false)).toBe(false)
    expect(unreviewedActive(false, true)).toBe(false)      // a normal user never sees it, whatever is stored on the device
    expect(unreviewedActive(true, false)).toBe(false)
    expect(unreviewedActive(true, true)).toBe(true)
  })
  it('follows the session role and the stored preference', () => {
    setUnreviewedPreference(true)
    expect(getUnreviewedPreference()).toBe(true)
    setAdminSession(false)
    expect(unreviewedShown()).toBe(false)
    setAdminSession(true)
    expect(unreviewedShown()).toBe(true)
    setAdminSession(false)                                  // signing out / losing the role switches it off again
    expect(unreviewedShown()).toBe(false)
    setUnreviewedPreference(false)
  })
})
