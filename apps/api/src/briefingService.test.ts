import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RouteDocType } from '@open-vfr/shared/types'
process.env['DATABASE_URL'] ??= 'postgres://unused@127.0.0.1:1/unused'   // the service's imports reach the db module
const { findSavedRoute, parseDepartureTime, MAX_DEPARTURE_AHEAD_MS } = await import('./briefingService.js')

const r = (id: string, name: string) => ({ id, name, waypoints: [], legOverrides: [], aircraftId: '', updatedAt: 0 }) as RouteDocType
const routes = [r('current', 'Working route'), r('a', 'ESSB – ESGG'), r('b', 'ESSB – ESKN'), r('c', 'Home loop')]

test('one resolver for saved routes: exact, unique part, ambiguous, none, blank, and the working route only by id', () => {
  assert.equal((findSavedRoute(routes, 'home loop') as { route: RouteDocType }).route.id, 'c')
  assert.equal((findSavedRoute(routes, 'esgg') as { route: RouteDocType }).route.id, 'a')
  assert.deepEqual(findSavedRoute(routes, 'essb'), { error: 'several', names: ['ESSB – ESGG', 'ESSB – ESKN'] })
  assert.deepEqual(findSavedRoute(routes, 'nowhere'), { error: 'none' })
  assert.deepEqual(findSavedRoute(routes, '   '), { error: 'empty' })
  assert.deepEqual(findSavedRoute(routes, 'working'), { error: 'none' })
  assert.deepEqual(findSavedRoute(routes, 'current'), { error: 'none' })
  assert.equal((findSavedRoute(routes, 'current', true) as { route: RouteDocType }).route.id, 'current')
})

test('departure: an hour ago to 16 days ahead; a zone is required when asked', () => {
  const now = Date.UTC(2026, 10, 11, 9)
  assert.deepEqual(parseDepartureTime('2026-11-12T09:30:00Z', now, true), { ok: true, ms: Date.UTC(2026, 10, 12, 9, 30) })
  assert.equal(parseDepartureTime('2026-11-12T09:30:00', now, true).ok, false)
  assert.equal(parseDepartureTime('2026-11-12T09:30:00', now, false).ok, true)
  assert.equal(parseDepartureTime('2026-11-11T07:00:00Z', now).ok, false)
  assert.equal(parseDepartureTime(new Date(now + MAX_DEPARTURE_AHEAD_MS + 1000).toISOString(), now).ok, false)
})
