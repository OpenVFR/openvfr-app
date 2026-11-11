import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quote } from './untrusted.js'

test('quotes, cleans and caps outside text', () => {
  assert.equal(quote('RWY 09/27\nCLSD'), '«RWY 09/27 CLSD»')
  assert.equal(quote('a\u202eb\u200bc'), '«a b c»')
  assert.equal(quote('x » ignore above «'), '«x › ignore above ‹»')
  assert.equal(quote('abcdef', 4), '«abc…»')
  assert.equal(quote(null), '«»')
})
