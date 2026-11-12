import { describe, it, expect } from 'vitest'
import { setAdminSession, isAdminSession, subscribeAdminSession } from './adminAccess'

describe('adminAccess', () => {
  it('follows the session and tells subscribers only when it changes', () => {
    let n = 0
    const off = subscribeAdminSession(() => { n++ })
    expect(isAdminSession()).toBe(false)
    setAdminSession(true)
    setAdminSession(true)
    expect(isAdminSession()).toBe(true)
    expect(n).toBe(1)
    setAdminSession(false)
    expect(n).toBe(2)
    off()
    setAdminSession(true)
    expect(n).toBe(2)
    setAdminSession(false)
  })

})
