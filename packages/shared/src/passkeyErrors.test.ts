import { describe, it, expect } from 'vitest'
import {
  passkeyRequestErrorMessage as msg, passkeyCeremonyOutcome, PASSKEY_RECENT_SIGN_IN_MESSAGE, PASSKEY_SESSION_EXPIRED_MESSAGE, PASSKEY_WRONG_SITE_MESSAGE,
} from './passkeyErrors'

describe('passkeyRequestErrorMessage', () => {
  it('explains a stale sign-in by code or by text', () => {
    expect(msg({ status: 403, code: 'SESSION_NOT_FRESH', message: 'x' }, 'f')).toBe(PASSKEY_RECENT_SIGN_IN_MESSAGE)
    expect(msg({ status: 403, message: 'Session is not fresh' }, 'f')).toBe(PASSKEY_RECENT_SIGN_IN_MESSAGE)
  })
  it('explains an invalid session', () => {
    expect(msg({ status: 401, message: 'Unauthorized' }, 'f')).toBe(PASSKEY_SESSION_EXPIRED_MESSAGE)
    expect(msg({ code: 'UNAUTHORIZED' }, 'f')).toBe(PASSKEY_SESSION_EXPIRED_MESSAGE)
  })
  it('keeps other server messages, else the fallback', () => {
    expect(msg({ status: 500, message: 'Boom' }, 'f')).toBe('Boom')
    expect(msg({}, 'Could not reach the server')).toBe('Could not reach the server')
  })
})

describe('passkeyCeremonyOutcome', () => {
  it('treats a dismissed prompt and "no credential" as cancelled (the browser cannot tell them apart)', () => {
    for (const code of ['AUTH_CANCELLED', 'ERROR_CEREMONY_ABORTED', 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY', undefined]) {
      expect(passkeyCeremonyOutcome({ code })).toEqual({ kind: 'cancelled' })
    }
  })
  it('says when the address is not the site the passkey was made for', () => {
    for (const code of ['ERROR_INVALID_RP_ID', 'ERROR_INVALID_DOMAIN']) {
      expect(passkeyCeremonyOutcome({ code })).toEqual({ kind: 'message', message: PASSKEY_WRONG_SITE_MESSAGE })
    }
  })
  it('names the code of an unknown failure instead of calling it a cancel', () => {
    const o = passkeyCeremonyOutcome({ code: 'ERROR_SOMETHING_NEW' })
    expect(o.kind).toBe('message')
    expect((o as { message: string }).message).toContain('ERROR_SOMETHING_NEW')
  })
})
