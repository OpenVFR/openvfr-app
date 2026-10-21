import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseFixedOtpAccounts } from './fixedOtpAccounts.js'

const CODE_A = '123456789012'   // review account: 10+ digits
const T1 = '12345678901234567890123456789012'   // test accounts: exactly 32 digits
const T2 = '98765432109876543210987654321098'

describe('parseFixedOtpAccounts', () => {
  it('is empty when nothing is configured', () => {
    assert.equal(parseFixedOtpAccounts({}).byEmail.size, 0)
  })

  it('keeps the review account working as before (email lower-cased)', () => {
    const { byEmail } = parseFixedOtpAccounts({ reviewEmail: 'AppReview@Example.org', reviewOtp: CODE_A })
    assert.equal(byEmail.get('appreview@example.org'), CODE_A)
  })

  it('refuses a review email without a code and the other way round', () => {
    assert.throws(() => parseFixedOtpAccounts({ reviewEmail: 'a@b.org' }), /both be set/)
    assert.throws(() => parseFixedOtpAccounts({ reviewOtp: CODE_A }), /both be set/)
  })

  it('parses a list of tester accounts next to the review account', () => {
    const { byEmail } = parseFixedOtpAccounts({
      reviewEmail: 'review@x.org', reviewOtp: CODE_A,
      testAccounts: ` apptest+ci@x.org:${T1} , apptest+e2e@x.org:${T2} `,
    })
    assert.deepEqual([...byEmail.keys()], ['review@x.org', 'apptest+ci@x.org', 'apptest+e2e@x.org'])
    assert.equal(byEmail.get('apptest+ci@x.org'), T1)
  })

  it('rejects short codes, so a never-expiring code cannot be brute forced', () => {
    assert.throws(() => parseFixedOtpAccounts({ testAccounts: 'a@x.org:123456' }), /at least 32/)
    assert.throws(() => parseFixedOtpAccounts({ testAccounts: `a@x.org:${CODE_A}` }), /at least 32/)   // 12 digits is enough for review, not for tests
    assert.throws(() => parseFixedOtpAccounts({ reviewEmail: 'a@x.org', reviewOtp: '123' }), /at least 10/)
  })

  it('rejects malformed entries without echoing the code', () => {
    for (const bad of ['nocolon', ':code1234567', 'a@x.org:', 'not-an-email:1234567890']) {
      assert.throws(() => parseFixedOtpAccounts({ testAccounts: bad }))
    }
    assert.throws(() => parseFixedOtpAccounts({ testAccounts: 'nocolon' }), (e: Error) => !e.message.includes('1234'))
  })

  it('rejects a duplicate email and a code shared between accounts', () => {
    assert.throws(() => parseFixedOtpAccounts({ testAccounts: `a@x.org:${T1},A@x.org:${T2}` }), /twice/)
    assert.throws(() => parseFixedOtpAccounts({ testAccounts: `a@x.org:${T1},b@x.org:${T1}` }), /same code/)
    assert.throws(() => parseFixedOtpAccounts({ reviewEmail: 'r@x.org', reviewOtp: T1, testAccounts: `t@x.org:${T1}` }), /same code/)
  })

  it('warns, but still accepts, codes the login UIs cannot type', () => {
    const { byEmail, warnings } = parseFixedOtpAccounts({ testAccounts: 'a@x.org:abcdefghijklmnopqrstuvwxyzabcdef' })
    assert.equal(byEmail.size, 1)
    assert.equal(warnings.length, 1)
  })

  it('warns about a test code longer than the 32 digits the login screens accept', () => {
    const { warnings } = parseFixedOtpAccounts({ testAccounts: `a@x.org:${T1}9` })
    assert.equal(warnings.length, 1)
  })
})
