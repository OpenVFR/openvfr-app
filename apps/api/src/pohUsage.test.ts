import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pohUsageLine } from './pohUsage.js'

test('reports tokens, size and time', () => {
  const line = pohUsageLine({ input_tokens: 152000, output_tokens: 900, total_tokens: 152900 }, 12.34, 41_250)
  assert.equal(line, '[poh-extract] usage: file=12.3MB model_time=41.3s input_tokens=152000 output_tokens=900 total_tokens=152900')
})

test('adds reasoning and cached tokens when present', () => {
  const line = pohUsageLine({ input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 }, input_tokens_details: { cached_tokens: 4 } }, 1, 1000)
  assert.match(line, /total_tokens=15 reasoning_tokens=3 cached_tokens=4$/)
})

test('computes the total when the service does not send one', () => {
  assert.match(pohUsageLine({ input_tokens: 100, output_tokens: 20 }, 1, 500), /total_tokens=120/)
})

test('missing or partial usage never throws', () => {
  assert.match(pohUsageLine(undefined, 2, 1500), /tokens=not reported$/)
  assert.match(pohUsageLine(null, 2, 1500), /tokens=not reported$/)
  assert.match(pohUsageLine({}, 2, 1500), /input_tokens=\? output_tokens=\? total_tokens=\?/)
  assert.match(pohUsageLine({ input_tokens: Number.NaN, output_tokens: 7 }, 2, 1500), /input_tokens=\? output_tokens=7 total_tokens=\?/)
})

test('the line carries numbers only', () => {
  const line = pohUsageLine({ input_tokens: 1, output_tokens: 1 }, 5, 1000)
  assert.doesNotMatch(line, /[A-Za-z0-9_-]+\.pdf|user|@/i)
})
