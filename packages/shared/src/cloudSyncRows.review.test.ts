import { describe, it, expect } from 'vitest'
import { routeRows } from './cloudSyncRows'

const base = { id: 'r', name: 'n', waypoints: [], legOverrides: [], aircraftId: '', updatedAt: 0 }

describe('routeRows assistant review mark', () => {
  it('reads a mark from the server and ignores junk', () => {
    expect(routeRows.fromServer({ ...base, assistant_review: { by: 'Claude', at: 1, change: 'created' } })?.assistantReview).toEqual({ by: 'Claude', at: 1, change: 'created' })
    expect(routeRows.fromServer({ ...base, assistant_review: { by: 'Claude', at: 1, change: ['name'] } })?.assistantReview).toEqual({ by: 'Claude', at: 1, change: ['name'] })
    expect(routeRows.fromServer({ ...base, assistant_review: null })).not.toHaveProperty('assistantReview')
    expect(routeRows.fromServer({ ...base, assistant_review: { change: 'x' } })).not.toHaveProperty('assistantReview')
  })
  it('sends the column only to clear a mark', () => {
    expect(routeRows.toServer(base, 'u')).not.toHaveProperty('assistant_review')
    expect(routeRows.toServer({ ...base, assistantReview: { by: 'Claude', at: 1, change: 'created' } }, 'u')).not.toHaveProperty('assistant_review')
    expect(routeRows.toServer({ ...base, assistantReview: null }, 'u')).toHaveProperty('assistant_review', null)
  })
})
