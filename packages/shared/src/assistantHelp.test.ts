import { describe, it, expect } from 'vitest'
import { assistantExamples, ASSISTANT_EXAMPLES, ASSISTANT_STEPS } from './assistantHelp'

describe('assistantHelp', () => {
  it('gives examples per topic, topped up and capped', () => {
    expect(assistantExamples('aircraft', 3)).toHaveLength(3)
    expect(assistantExamples('route')).toEqual(ASSISTANT_EXAMPLES.route)
    expect(assistantExamples('general', 10)).toEqual(ASSISTANT_EXAMPLES.general)
  })
  it('names no product', () => {
    const all = [...ASSISTANT_STEPS, ...Object.values(ASSISTANT_EXAMPLES).flat()].join(' ')
    expect(all).not.toMatch(/claude|chatgpt|gemini|openai|anthropic|google/i)
  })
})
