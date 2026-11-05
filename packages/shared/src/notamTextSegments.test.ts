import { describe, it, expect, vi } from 'vitest'
import { splitNotamTextCoordinates } from './notamTextSegments'
import { focusNotamCoordinate, subscribeNotamCoordinateFocus, getNotamCoordinateFocus, clearNotamCoordinateFocus } from './notamCoordinateFocus'

describe('splitNotamTextCoordinates', () => {
  it('cuts text around each coordinate and keeps every character', () => {
    const t = 'OBST AT 551234N 0141234E, 90FT AND 551300N0141300E.'
    const s = splitNotamTextCoordinates(t)
    expect(s.map(x => x.text).join('')).toBe(t)
    const c = s.filter(x => x.kind === 'coordinate')
    expect(c.map(x => x.text)).toEqual(['551234N 0141234E', '551300N0141300E'])
    expect(c[0]).toMatchObject({ lat: expect.closeTo(55.2094, 3), lng: expect.closeTo(14.2094, 3) })
  })
  it('finds a coordinate split by a line break', () => {
    const t = 'AREA 545000N010000\n0E-543000N0120000E'
    const s = splitNotamTextCoordinates(t)
    expect(s.map(x => x.text).join('')).toBe(t)
    const c = s.filter(x => x.kind === 'coordinate')
    expect(c.map(x => x.text)).toEqual(['545000N010000\n0E', '543000N0120000E'])
    expect(c[0]).toMatchObject({ lat: expect.closeTo(54.8333, 3), lng: 10 })
  })
  it('text without coordinates is one plain segment; empty gives none', () => {
    expect(splitNotamTextCoordinates('RWY 09 CLOSED')).toEqual([{ kind: 'text', text: 'RWY 09 CLOSED' }])
    expect(splitNotamTextCoordinates('')).toEqual([])
  })
})

describe('notamCoordinateFocus', () => {
  it('notifies subscribers, repeats the same point with a new seq, clears', () => {
    const seen: (number | null)[] = []
    const off = subscribeNotamCoordinateFocus(f => seen.push(f ? f.seq : null))
    focusNotamCoordinate({ lat: 1, lng: 2 })
    focusNotamCoordinate({ lat: 1, lng: 2 })
    expect(getNotamCoordinateFocus()).toMatchObject({ lat: 1, lng: 2 })
    clearNotamCoordinateFocus()
    off()
    focusNotamCoordinate({ lat: 3, lng: 4 })
    expect(seen).toHaveLength(3)
    expect(seen[0]).not.toBe(seen[1])
    expect(seen[2]).toBeNull()
    clearNotamCoordinateFocus()
    vi.restoreAllMocks()
  })
})
