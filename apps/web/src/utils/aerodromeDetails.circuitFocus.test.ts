import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { chooseRunwayEndOnMap, setCircuitFocus, setMountedCard, takePendingCircuitFocus } from './aerodromeDetails'


describe('choosing a runway end on the map', () => {
  beforeEach(() => { setMountedCard(null); setCircuitFocus(null); takePendingCircuitFocus('x') })
  afterEach(() => vi.useRealTimers())

  it('waits for the card when it is not open, and the card takes it once', () => {
    expect(chooseRunwayEndOnMap({ aerodrome: 'ESTT', runway: '03' })).toBe(false)
    expect(takePendingCircuitFocus('ESTT')).toEqual({ aerodrome: 'ESTT', runway: '03' })
    expect(takePendingCircuitFocus('ESTT')).toEqual({ aerodrome: 'ESTT', runway: '03' })      // the immediate second run of a development effect
    vi.useFakeTimers(); vi.advanceTimersByTime(1000)
    expect(takePendingCircuitFocus('ESTT')).toBeNull()                                         // but not for a card that opens later
  })

  it('is applied at once when that aerodrome card is open', () => {
    setMountedCard('ESTT')
    expect(chooseRunwayEndOnMap({ aerodrome: 'ESTT', runway: '03' })).toBe(true)
    expect(takePendingCircuitFocus('ESTT')).toBeNull()
  })

  it('a card for another aerodrome does not take it', () => {
    chooseRunwayEndOnMap({ aerodrome: 'ESTT', runway: '03' })
    expect(takePendingCircuitFocus('ESME')).toBeNull()
    expect(takePendingCircuitFocus('ESTT')).toBeNull()      // looking at it for another aerodrome discards a waiting choice: one tap, one card
  })

  it('a choice whose card never opens expires', () => {
    vi.useFakeTimers()
    chooseRunwayEndOnMap({ aerodrome: 'ESTT', runway: '03' })
    vi.advanceTimersByTime(5000)
    expect(takePendingCircuitFocus('ESTT')).toBeNull()
  })
})
