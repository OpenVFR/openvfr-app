import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  rejectionReason,
  planSync, TableSync, SyncCoordinator, queuePendingDelete,
  type TableAdapter, type SyncStorage, type SyncTransport, type Tombstone,
} from './cloudSync'

// ─── Fake PostgREST with the sync_tombstones migration's rules ──────────────

type Row = Record<string, unknown> & { user_id: string; updated_at: string }

class FakeServer {
  tables = new Map<string, Map<string, Row>>()
  tombstones = new Map<string, number>()   // `${table}|${id}` -> ms
  online = true
  failNext: number | null = null
  hasTombstoneTable = true
  hasRpc = true
  requests: string[] = []
  validJwt = 'jwt-1'

  private table(name: string) {
    let t = this.tables.get(name)
    if (!t) { t = new Map(); this.tables.set(name, t) }
    return t
  }
  idCol(table: string) { return table === 'user_settings' ? 'key' : 'id' }

  /** Server-side delete (tombstone written), at `at` (client time, rpc) or server now. */
  delete(table: string, id: string, at = Date.now()) {
    const row = this.table(table).get(id)
    if (!row) return
    this.table(table).delete(id)
    const key = `${table}|${id}`
    this.tombstones.set(key, Math.max(Math.min(at, Date.now() + 120_000), Date.parse(row.updated_at)))
  }

  /** Returns the stored row, or null when skipped. */
  private upsert(table: string, input: Row, ignoreDuplicates: boolean): Row | null {
    const id = String(input[this.idCol(table)])
    const t = this.table(table)
    const existing = t.get(id)
    const ts = Math.min(Date.parse(input.updated_at), Date.now() + 120_000)  // clock guard
    const row = { ...input, updated_at: new Date(ts).toISOString() }
    if (existing) {
      if (ignoreDuplicates) return null
      if (ts < Date.parse(existing.updated_at)) return null     // LWW guard
      t.set(id, row)
      return row
    }
    const key = `${table}|${id}`
    const tomb = this.tombstones.get(key)
    if (tomb !== undefined) {
      if (ts <= tomb) return null                               // stale copy of a deleted row
      this.tombstones.delete(key)
    }
    t.set(id, row)
    return row
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url))
    const method = init?.method ?? 'GET'
    this.requests.push(`${method} ${u.pathname}${u.search}`)
    if (!this.online) throw new TypeError('fetch failed: Unable to resolve host')
    const auth = (init?.headers as Record<string, string>)?.Authorization
    if (auth !== `Bearer ${this.validJwt}`) return new Response('jwt expired', { status: 401 })
    if (this.failNext !== null) {
      const status = this.failNext
      this.failNext = null
      return new Response('boom', { status })
    }
    const table = u.pathname.split('/').pop()!
    const q = u.searchParams
    if (u.pathname.endsWith('/rpc/sync_delete')) {
      if (!this.hasRpc) return new Response('{"code":"PGRST202"}', { status: 404 })
      const b = JSON.parse(String(init!.body)) as { p_table: string; p_id: string; p_deleted_at: string }
      this.delete(b.p_table, b.p_id, Date.parse(b.p_deleted_at))
      return new Response(null, { status: 204 })
    }
    if (table === 'user_sync_tombstones') {
      if (!this.hasTombstoneTable) return new Response('{"code":"PGRST205"}', { status: 404 })
      const name = q.get('table_name')!.replace(/^eq\./, '')
      const rows = [...this.tombstones].filter(([k]) => k.startsWith(`${name}|`))
        .map(([k, at]) => ({ row_id: k.slice(name.length + 1), deleted_at: new Date(at).toISOString() }))
      return Response.json(rows)
    }
    const idc = this.idCol(table)
    const t = this.table(table)
    if (method === 'GET') {
      let rows = [...t.values()]
      const inQ = q.get(idc)
      if (inQ?.startsWith('in.(')) {
        const ids = inQ.slice(4, -1).split(',').map(s => JSON.parse(s) as string)
        rows = rows.filter(r => ids.includes(String(r[idc])))
      }
      const select = q.get('select')
      if (select && select !== '*') {
        const cols = select.split(',')
        rows = rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]])) as Row)
      }
      return Response.json(rows)
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init!.body)) as Row[]
      const prefer = (init!.headers as Record<string, string>).Prefer ?? ''
      const stored = body.map(r => this.upsert(table, r, prefer.includes('ignore-duplicates'))).filter(Boolean) as Row[]
      const cols = (q.get('select') ?? '*').split(',')
      return Response.json(cols[0] === '*' ? stored : stored.map(r => Object.fromEntries(cols.map(c => [c, r[c]]))), { status: 201 })
    }
    if (method === 'DELETE') {
      const id = q.get(idc)!.replace(/^eq\./, '')
      this.delete(table, id)
      return new Response(null, { status: 204 })
    }
    return new Response('?', { status: 405 })
  }
}

// ─── A device: in-memory store + adapter ────────────────────────────────────

interface Doc { id: string; name: string; updatedAt: number }

class Device {
  docs = new Map<string, Doc>()
  kv = new Map<string, string>()
  jwt = 'jwt-1'
  storageBroken = false
  storage!: SyncStorage
  sync: TableSync<Doc>

  constructor(server: FakeServer, opts: { immutable?: boolean; table?: 'user_routes' | 'user_flight_logs' } = {}) {
    const table = opts.table ?? 'user_routes'
    const adapter: TableAdapter<Doc> = {
      table,
      immutable: opts.immutable,
      uploadBatch: 2,
      list: async () => [...this.docs.values()],
      version: d => ({ id: d.id, updatedAt: d.updatedAt }),
      fromServer: r => ({ id: String(r.id), name: String(r.name), updatedAt: Date.parse(String(r.updated_at)) }),
      toServer: (d, userId) => ({ id: d.id, user_id: userId, name: d.name, updated_at: new Date(d.updatedAt).toISOString() }),
      apply: async rows => {
        for (const r of rows) {
          const cur = this.docs.get(r.id)
          if (!cur || cur.updatedAt < r.updatedAt) this.docs.set(r.id, r)
        }
      },
      remove: async (rows: Tombstone[]) => {
        for (const t of rows) {
          const cur = this.docs.get(t.id)
          if (cur && cur.updatedAt <= t.deletedAt) this.docs.delete(t.id)
        }
      },
      restamp: async rows => {
        for (const r of rows) {
          const cur = this.docs.get(r.id)
          if (cur && cur.updatedAt === r.from) this.docs.set(r.id, { ...cur, updatedAt: r.to })
        }
      },
    }
    const storage: SyncStorage = this.storage = {
      get: async k => { if (this.storageBroken) throw new Error('storage unavailable'); return this.kv.get(k) ?? null },
      set: async (k, v) => { this.kv.set(k, v) },
      remove: async k => { this.kv.delete(k) },
    }
    const transport: SyncTransport = {
      restBase: 'https://api.test/rest',
      getJwt: async () => (server.online ? this.jwt : null),
      invalidateJwt: () => { this.jwt = server.validJwt },
      fetch: ((u: string, i?: RequestInit) => server.fetch(u, i)) as typeof fetch,
    }
    this.sync = new TableSync(adapter, transport, storage, 'u1')
  }

  edit(id: string, name: string, at: number) { this.docs.set(id, { id, name, updatedAt: at }) }
  async del(id: string) { this.docs.delete(id); await this.sync.queueDelete(id, Date.now()) }
  names() { return Object.fromEntries([...this.docs.values()].map(d => [d.id, d.name])) }
}

let now = 1_700_000_000_000
const tick = (ms = 1000) => (now += ms)

beforeEach(() => {
  now = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

// ─── planSync ───────────────────────────────────────────────────────────────

describe('planSync', () => {
  const version = (d: Doc) => ({ id: d.id, updatedAt: d.updatedAt })
  const d = (id: string, updatedAt: number): Doc => ({ id, name: id, updatedAt })

  it('downloads newer/missing, uploads newer/local-only, removes deleted-elsewhere', () => {
    const plan = planSync({
      local: [d('same', 5), d('older', 1), d('newer', 9), d('onlyLocal', 3), d('deleted', 2), d('editedAfterDelete', 8)],
      version,
      server: [{ id: 'same', updatedAt: 5 }, { id: 'older', updatedAt: 4 }, { id: 'newer', updatedAt: 4 }, { id: 'onlyServer', updatedAt: 1 }],
      tombstones: [{ id: 'deleted', deletedAt: 6 }, { id: 'editedAfterDelete', deletedAt: 6 }],
    })
    expect(plan.download.sort()).toEqual(['older', 'onlyServer'])
    expect(plan.upload.map(x => x.id).sort()).toEqual(['editedAfterDelete', 'newer', 'onlyLocal'])
    expect(plan.removeLocal).toEqual([{ id: 'deleted', deletedAt: 6 }])
  })

  it('immutable tables only upload rows the server lacks', () => {
    const plan = planSync({
      local: [d('a', 9), d('b', 1)], version,
      server: [{ id: 'a', updatedAt: 4 }], tombstones: [], immutable: true,
    })
    expect(plan.upload.map(x => x.id)).toEqual(['b'])
  })

  it('ignores ids with a queued delete', () => {
    const plan = planSync({
      local: [], version, server: [{ id: 'x', updatedAt: 1 }], tombstones: [],
      pendingDeletes: new Set(['x']),
    })
    expect(plan.download).toEqual([])
  })
})

// ─── Two devices against one server ─────────────────────────────────────────

describe('TableSync two-way', () => {
  it('uploads a row created offline once back online (no time-based guessing)', async () => {
    const server = new FakeServer()
    const a = new Device(server)
    await a.sync.run()
    server.online = false
    a.edit('r1', 'flight', tick())
    expect((await a.sync.run()).status).toBe('offline')
    tick(60_000)
    server.online = true
    // Several successful rounds may have happened meanwhile; the row survives.
    expect((await a.sync.run()).status).toBe('ok')
    expect(a.names()).toEqual({ r1: 'flight' })
    expect(server.tables.get('user_routes')!.has('r1')).toBe(true)
  })

  it('a failed upload keeps the row local and retries it', async () => {
    const server = new FakeServer()
    const a = new Device(server)
    a.edit('r1', 'x', tick())
    server.failNext = 500   // the version list fetch fails
    expect((await a.sync.run()).status).toBe('error')
    expect(a.names()).toEqual({ r1: 'x' })
    expect((await a.sync.run()).status).toBe('ok')
    expect(server.tables.get('user_routes')!.has('r1')).toBe(true)
    expect(a.names()).toEqual({ r1: 'x' })
  })

  it('propagates edits both ways', async () => {
    const server = new FakeServer()
    const a = new Device(server), b = new Device(server)
    a.edit('r1', 'from A', tick())
    await a.sync.run()
    await b.sync.run()
    expect(b.names()).toEqual({ r1: 'from A' })
    b.edit('r1', 'edited on B', tick())
    b.edit('r2', 'new on B', tick())
    await b.sync.run()
    await a.sync.run()
    expect(a.names()).toEqual({ r1: 'edited on B', r2: 'new on B' })
  })

  it('propagates deletes, including ones made offline', async () => {
    const server = new FakeServer()
    const a = new Device(server), b = new Device(server)
    a.edit('r1', 'one', tick()); a.edit('r2', 'two', tick())
    await a.sync.run(); await b.sync.run()
    server.online = false
    tick()
    await a.del('r1')
    expect((await a.sync.run()).status).toBe('offline')
    server.online = true
    tick()
    await a.sync.run()
    expect(server.tables.get('user_routes')!.has('r1')).toBe(false)
    await b.sync.run()
    expect(b.names()).toEqual({ r2: 'two' })
    // B never resurrects it, A never re-downloads it.
    await b.sync.run(); await a.sync.run()
    expect(a.names()).toEqual({ r2: 'two' })
    expect(server.tables.get('user_routes')!.has('r1')).toBe(false)
  })

  it('an edit made after a delete elsewhere wins over the delete', async () => {
    const server = new FakeServer()
    const a = new Device(server), b = new Device(server)
    a.edit('r1', 'v1', tick())
    await a.sync.run(); await b.sync.run()
    await a.del('r1'); tick(); await a.sync.run()
    b.edit('r1', 'v2 edited later', tick())
    await b.sync.run()
    await a.sync.run()
    expect(a.names()).toEqual({ r1: 'v2 edited later' })
  })

  it('a stale device does not resurrect a deleted row', async () => {
    const server = new FakeServer()
    const a = new Device(server), b = new Device(server)
    a.edit('r1', 'v1', tick())
    await a.sync.run(); await b.sync.run()
    tick(); await a.del('r1'); await a.sync.run()
    // B was offline the whole time, comes back with its unchanged copy.
    await b.sync.run()
    expect(b.names()).toEqual({})
    expect(server.tables.get('user_routes')!.has('r1')).toBe(false)
  })

  it('last write wins: an older offline edit does not overwrite a newer one', async () => {
    const server = new FakeServer()
    const a = new Device(server), b = new Device(server)
    a.edit('r1', 'v1', tick())
    await a.sync.run(); await b.sync.run()
    server.online = false
    a.edit('r1', 'A offline edit', tick())
    await a.sync.run()
    server.online = true
    b.edit('r1', 'B later edit', tick())
    await b.sync.run()
    await a.sync.run()
    expect(a.names()).toEqual({ r1: 'B later edit' })
    expect(server.tables.get('user_routes')!.get('r1')!.name).toBe('B later edit')
  })

  it('a server error never deletes local rows', async () => {
    const server = new FakeServer()
    const a = new Device(server)
    a.edit('r1', 'x', tick())
    await a.sync.run()
    tick()
    server.failNext = 503
    await a.sync.run()
    expect(a.names()).toEqual({ r1: 'x' })
  })

  it('refreshes an expired token once on 401', async () => {
    const server = new FakeServer()
    const a = new Device(server)
    a.jwt = 'expired'
    a.edit('r1', 'x', tick())
    expect((await a.sync.run()).status).toBe('ok')
    expect(server.tables.get('user_routes')!.has('r1')).toBe(true)
  })

  it('works against a server without the tombstone table (uploads, never guesses deletes)', async () => {
    const server = new FakeServer()
    server.hasTombstoneTable = false
    const a = new Device(server)
    a.edit('r1', 'x', tick())
    expect((await a.sync.run()).status).toBe('ok')
    expect(server.tables.get('user_routes')!.has('r1')).toBe(true)
  })

  it('isolates a row the server rejects and still uploads the rest', async () => {
    for (const [status, expected] of [[503, 'error'], [413, 'ok']] as const) {
      const server = new FakeServer()
      const a = new Device(server)
      a.edit('r1', 'a', tick()); a.edit('r2', 'b', tick()); a.edit('r3', 'c', tick())
      const orig = server.fetch
      server.fetch = async (url, init) => {
        if (init?.method === 'POST' && String(init.body).includes('"r2"')) return new Response('bad', { status })
        return orig(url, init)
      }
      const r = await a.sync.run()
      // Transient (5xx): retried later. Permanent (4xx, e.g. too large): logged,
      // not counted as unsynced forever.
      expect(r.status).toBe(expected)
      expect(await a.sync.hasUnsynced()).toBe(expected === 'error')
      expect([...server.tables.get('user_routes')!.keys()].sort()).toEqual(['r1', 'r3'])
    }
  })

  it('remembers rows the server refused, with the reason, until they upload or are deleted', async () => {
    const server = new FakeServer()
    const a = new Device(server)
    a.edit('r1', 'a', tick()); a.edit('big', 'b', tick())
    const orig = server.fetch
    let refuse = true
    server.fetch = async (url, init) => {
      if (refuse && init?.method === 'POST' && String(init.body).includes('"big"')) {
        return new Response('{"code":"23514","message":"new row for relation \\"user_routes\\" violates check constraint \\"user_routes_size_chk\\""}', { status: 400 })
      }
      return orig(url, init)
    }
    expect((await a.sync.run()).status).toBe('ok')
    expect([...a.sync.rejected.keys()]).toEqual(['big'])
    expect(a.sync.rejected.get('big')!.reason).toBe('too-large')
    // Edited down / limit raised: accepted on a later round, no longer listed.
    refuse = false
    a.edit('big', 'smaller', tick())
    await a.sync.run()
    expect(a.sync.rejected.size).toBe(0)
    // Refused again, then deleted on this device: dropped from the list.
    refuse = true
    a.edit('big2', 'x', tick()); a.edit('big', 'big again', tick())
    await a.sync.run()
    expect(a.sync.rejected.has('big')).toBe(true)
    a.docs.delete('big')
    await a.sync.run()
    expect(a.sync.rejected.has('big')).toBe(false)
  })

  it('classifies refusals', () => {
    expect(rejectionReason('violates check constraint "user_aircraft_profiles_size_chk"')).toBe('too-large')
    expect(rejectionReason('quota exceeded: at most 500 rows in user_aircraft_profiles')).toBe('quota')
    expect(rejectionReason('column "x" does not exist')).toBe('refused')
  })

  it('a delete followed by a re-create keeps device order even when the device clock is behind', async () => {
    const server = new FakeServer()
    const a = new Device(server), b = new Device(server)
    // Device A's clock runs 10 min behind the server.
    const aClock = () => tick() - 600_000
    a.edit('home', 'ESSB', aClock())
    await a.sync.run(); await b.sync.run()
    // Clear the setting, set it again seconds later; both reach the server
    // in one round. The server-time delete would be newer than the re-create.
    a.docs.delete('home'); await a.sync.queueDelete('home', aClock())
    a.edit('home', 'ESOW', aClock())
    await a.sync.run()
    expect(a.names()).toEqual({ home: 'ESOW' })
    await b.sync.run()
    expect(b.names()).toEqual({ home: 'ESOW' })
  })

  it('falls back to a plain DELETE on a server without rpc/sync_delete', async () => {
    const server = new FakeServer()
    server.hasRpc = false
    const a = new Device(server)
    a.edit('r1', 'x', tick()); await a.sync.run()
    await a.del('r1'); tick()
    expect((await a.sync.run()).status).toBe('ok')
    expect(server.tables.get('user_routes')!.has('r1')).toBe(false)
  })

  it('adopts the server time when its clock guard clamps a fast device clock', async () => {
    const server = new FakeServer()
    const fast = new Device(server), ok = new Device(server)
    fast.edit('r1', 'from fast clock', now + 86_400_000)   // a day ahead
    await fast.sync.run()
    const stored = Date.parse(server.tables.get('user_routes')!.get('r1')!.updated_at)
    expect(stored).toBeLessThanOrEqual(now + 120_000)
    expect(fast.docs.get('r1')!.updatedAt).toBe(stored)
    // A correct device editing later still wins.
    await ok.sync.run()
    tick(300_000)
    ok.edit('r1', 'later edit', now)
    await ok.sync.run(); await fast.sync.run()
    expect(fast.names()).toEqual({ r1: 'later edit' })
  })

  it('does not drop queued deletes when storage cannot be read', async () => {
    const server = new FakeServer()
    const a = new Device(server)
    a.edit('r1', 'x', tick()); await a.sync.run()
    const fresh = new Device(server)
    fresh.kv = a.kv                     // same persisted storage, new process
    await a.del('r1')
    const key = [...a.kv.keys()].find(k => k.startsWith('outbox:'))!
    const before = a.kv.get(key)
    fresh.storageBroken = true
    expect((await fresh.sync.run()).status).toBe('error')
    expect(a.kv.get(key)).toBe(before)  // nothing overwritten
    fresh.storageBroken = false
    expect((await fresh.sync.run()).status).toBe('ok')
    expect(server.tables.get('user_routes')!.has('r1')).toBe(false)
  })

  it('sends deletes queued before sync started for the account', async () => {
    const server = new FakeServer()
    const a = new Device(server)
    a.edit('r1', 'x', tick()); await a.sync.run()
    const restarted = new Device(server)
    restarted.kv = a.kv
    restarted.docs = new Map(a.docs)
    restarted.docs.delete('r1')
    await queuePendingDelete(restarted.storage, 'user_routes', 'r1', tick())
    expect((await restarted.sync.run()).status).toBe('ok')
    expect(restarted.names()).toEqual({})
    expect(server.tables.get('user_routes')!.has('r1')).toBe(false)
  })

  it('times out a hung request instead of hanging the round', async () => {
    vi.useFakeTimers()
    try {
      const server = new FakeServer()
      const a = new Device(server)
      const orig = server.fetch
      server.fetch = (url, init) => String(url).includes('select=id,updated_at')
        ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
        : orig(url, init)
      const p = a.sync.run()
      await vi.advanceTimersByTimeAsync(31_000)
      const r = await p
      expect(r.status).toBe('offline')
      expect(r.message).toMatch(/timed out/)
      await a.sync.settled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a throwing listener does not wedge the table', async () => {
    const server = new FakeServer()
    const a = new Device(server)
    a.sync.subscribe(() => { throw new Error('UI bug') })
    a.edit('r1', 'x', tick())
    expect((await a.sync.run()).status).toBe('ok')
    expect(a.sync.isRunning).toBe(false)
    a.edit('r2', 'y', tick())
    expect((await a.sync.run()).status).toBe('ok')
    expect(server.tables.get('user_routes')!.has('r2')).toBe(true)
  })

  it('canUpload=false rows are download-only', () => {
    const plan = planSync({
      local: [{ id: 'k', updatedAt: 0 }], version: d => d, server: [], tombstones: [],
      canUpload: d => d.updatedAt > 0,
    })
    expect(plan.upload).toEqual([])
  })

  it('flight logs: upload-only, a log finished offline reaches the server later', async () => {
    const server = new FakeServer()
    const phone = new Device(server, { table: 'user_flight_logs', immutable: true })
    const web   = new Device(server, { table: 'user_flight_logs', immutable: true })
    server.online = false
    phone.edit('log1', 'ESSB-ESOW', tick())
    await phone.sync.run()
    tick(3_600_000)
    server.online = true
    await phone.sync.run()
    await web.sync.run()
    expect(web.names()).toEqual({ log1: 'ESSB-ESOW' })
  })
})

describe('SyncCoordinator', () => {
  it('retries a failed table with backoff until it succeeds', async () => {
    vi.useFakeTimers()
    try {
      const server = new FakeServer()
      const a = new Device(server)
      const c = new SyncCoordinator([a.sync as TableSync<unknown>], { retryMinMs: 1000, periodMs: 1e9 })
      server.online = false
      a.edit('r1', 'x', tick())
      expect(await c.syncAll()).toBe(false)
      expect(c.status).toBe('offline')
      server.online = true
      await vi.advanceTimersByTimeAsync(1000)
      expect(server.tables.get('user_routes')!.has('r1')).toBe(true)
      expect(c.status).toBe('idle')
      expect(await c.hasUnsynced()).toBe(false)
      c.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('advances the backoff once per failed round, however many callers joined it', async () => {
    vi.useFakeTimers()
    try {
      const server = new FakeServer()
      server.online = false
      const a = new Device(server)
      const runs = vi.spyOn(a.sync, 'run')
      const c = new SyncCoordinator([a.sync as TableSync<unknown>], { retryMinMs: 1000, retryMaxMs: 64_000, periodMs: 1e9 })
      await Promise.all([c.syncTable('user_routes'), c.syncTable('user_routes'), c.syncTable('user_routes')])
      runs.mockClear()
      // One retry after 1 s (not 4 s), then 2 s.
      await vi.advanceTimersByTimeAsync(1000)
      expect(runs).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1999)
      expect(runs).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(runs).toHaveBeenCalledTimes(2)
      await c.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
