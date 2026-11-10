import { describe, it, expect } from 'vitest'
import {
  passkeyRequestErrorMessage as msg, PASSKEY_RECENT_SIGN_IN_MESSAGE, PASSKEY_SESSION_EXPIRED_MESSAGE,
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
