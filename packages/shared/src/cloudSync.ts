/**
 * cloudSync — two-way sync of the user_* tables between a device's local
 * store and PostgREST, shared by web (RxDB) and native (AsyncStorage).
 *
 * Model
 * -----
 * Every synced row carries `updatedAt` (ms, set by the device that edited
 * it). The server keeps the same value in `updated_at` and enforces, in the
 * database (migration `sync_tombstones`):
 *   - last write wins: an upload older than the stored row is ignored;
 *   - deletes leave a tombstone (`user_sync_tombstones`), and an upload that
 *     is not newer than the tombstone is ignored;
 *   - timestamps far in the future (a device clock running fast) are clamped;
 *     uploads read back the stored value and the device adopts it (`restamp`).
 *
 * A device syncs a table in rounds (TableSync.run):
 *   1. Send queued deletes (the outbox; a delete made offline leaves no local
 *      trace, so it must be remembered, with the time it was made, until the
 *      server confirms it).
 *   2. Fetch the server's (id, updated_at) list and the table's tombstones.
 *   3. planSync decides per row: download (server newer or local missing),
 *      upload (local newer, or only local and not deleted), or remove locally
 *      (deleted elsewhere after this device's last edit).
 *   4. Download changed rows in full, upload the rest.
 * Rounds are idempotent: running one again with nothing changed does nothing,
 * and a round interrupted anywhere (offline, app killed) is completed by the
 * next. Nothing depends on "when did this device last sync", so a failed
 * upload can never be mistaken for a delete made elsewhere.
 *
 * SyncCoordinator runs the rounds: soon after a local change, on a timer, on
 * request (app foreground / back online), and with backoff after a failure.
 */

export type SyncTable =
  | 'user_routes'
  | 'user_aircraft_profiles'
  | 'user_waypoints'
  | 'user_settings'
  | 'user_flight_logs'

export interface RowVersion { id: string; updatedAt: number }
export interface Tombstone  { id: string; deletedAt: number }
/** Server stored a different updated_at than uploaded (clock guard): adopt it. */
export interface Restamp    { id: string; from: number; to: number }

export interface SyncPlan<L> {
  /** Ids whose server row must be downloaded (new or newer on the server). */
  download: string[]
  /** Local rows the server lacks or has an older version of. */
  upload: L[]
  /** Local rows deleted on another device (after this device's last edit). */
  removeLocal: Tombstone[]
}

/**
 * Decide what a sync round does. Pure: no I/O, no clock.
 *
 * `immutable` tables (flight logs) never update a server row: a local row is
 * uploaded only when the server has none. `canUpload` false keeps a row
 * download-only (e.g. a setting never edited while signed in).
 */
export function planSync<L>(input: {
  local:           readonly L[]
  version:         (l: L) => RowVersion
  server:          readonly RowVersion[]
  tombstones:      readonly Tombstone[]
  pendingDeletes?: { has(id: string): boolean }
  immutable?:      boolean
  canUpload?:      (l: L) => boolean
}): SyncPlan<L> {
  const pending  = input.pendingDeletes ?? new Set<string>()
  const canUpload = input.canUpload ?? (() => true)
  const serverBy = new Map(input.server.map(s => [s.id, s.updatedAt]))
  const tombBy   = new Map(input.tombstones.map(t => [t.id, t.deletedAt]))
  const localIds = new Set<string>()
  const plan: SyncPlan<L> = { download: [], upload: [], removeLocal: [] }

  for (const l of input.local) {
    const v = input.version(l)
    localIds.add(v.id)
    if (pending.has(v.id)) continue
    const serverTs = serverBy.get(v.id)
    if (serverTs !== undefined) {
      if (serverTs > v.updatedAt) plan.download.push(v.id)
      else if (serverTs < v.updatedAt && !input.immutable && canUpload(l)) plan.upload.push(l)
      continue
    }
    const deletedAt = tombBy.get(v.id)
    if (deletedAt !== undefined && v.updatedAt <= deletedAt) {
      plan.removeLocal.push({ id: v.id, deletedAt })
    } else if (canUpload(l)) {
      plan.upload.push(l)
    }
  }
  for (const s of input.server) {
    if (!localIds.has(s.id) && !pending.has(s.id)) plan.download.push(s.id)
  }
  return plan
}

// ─── Platform interfaces ────────────────────────────────────────────────────

/** Small persistent key-value store (localStorage / AsyncStorage). */
export interface SyncStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export interface SyncTransport {
  /** PostgREST base URL, e.g. `${API}/rest`. */
  restBase: string
  /** Current PostgREST JWT, or null when it cannot be obtained (offline / signed out). */
  getJwt(): Promise<string | null>
  /** Drop a cached JWT after the server rejected it (401). */
  invalidateJwt?(): void
  fetch?: typeof fetch
  log?: (...args: unknown[]) => void
  /** Per-request timeout (ms); uploads get 4x. Default 30 s. */
  timeoutMs?: number
}

/**
 * Server row mapping of one table: identical on every platform, so it lives
 * in ./cloudSyncRows.ts.
 */
export interface RowSpec<L> {
  table:          SyncTable
  /** Server column identifying a row for clients: 'key' for user_settings. */
  idColumn?:      'id' | 'key'
  immutable?:     boolean
  downloadBatch?: number
  uploadBatch?:   number
  version(l: L): RowVersion
  fromServer(row: Record<string, unknown>): L | null
  toServer(l: L, userId: string): Record<string, unknown>
  /** False: never upload this row (still downloaded / removed as usual). */
  canUpload?(l: L): boolean
}

/**
 * Local side of one table. `apply`, `remove` and `restamp` must re-check
 * each row against the current local copy, because the user may have edited
 * it while the round was talking to the server:
 *   - apply: write a server row only if the local row is missing or older;
 *   - remove: delete only if the local row's updatedAt <= deletedAt;
 *   - restamp: set updatedAt to `to` only if it is still `from`.
 */
export interface TableAdapter<L> extends RowSpec<L> {
  /** Local rows that take part in sync (skip working copies, in-progress logs). */
  list():   Promise<L[]>
  apply(rows: L[]): Promise<void>
  remove(rows: Tombstone[]): Promise<void>
  restamp?(rows: Restamp[]): Promise<void>
}

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error'

export interface SyncResult {
  status:       'ok' | 'offline' | 'error'
  /** Local rows were written or removed (UI lists should reload). */
  changedLocal: boolean
  message?:     string
}

class OfflineError extends Error {}
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** HTTP errors that will not go away by retrying the same request. */
const isPermanent = (err: unknown) =>
  err instanceof HttpError && err.status >= 400 && err.status < 500 &&
  err.status !== 401 && err.status !== 408 && err.status !== 429

const parseTs = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(t) ? t : 0
}

/** Quote an id for a PostgREST `in.(...)` list. */
const inList = (ids: readonly string[]) =>
  `(${ids.map(id => `"${id.replace(/["\\]/g, m => `\\${m}`)}"`).join(',')})`

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

// ─── Outbox (queued deletes) ────────────────────────────────────────────────

type Outbox = Map<string, number>   // id -> when the user deleted it (ms)

const outboxKey  = (userId: string, table: SyncTable) => `outbox:${userId}:${table}`
const pendingKey = (table: SyncTable) => `outbox:pending:${table}`

function parseOutbox(raw: string | null, log: (...a: unknown[]) => void): Outbox {
  if (!raw) return new Map()
  try {
    const v = JSON.parse(raw) as unknown
    // Older format: a plain id list.
    if (Array.isArray(v)) return new Map(v.map(id => [String(id), Date.now()]))
    if (v && typeof v === 'object') {
      return new Map(Object.entries(v as Record<string, unknown>).map(([id, at]) => [id, Number(at) || Date.now()]))
    }
  } catch { /* unreadable: start over */ }
  log('outbox unreadable, starting empty')
  return new Map()
}

/**
 * Queue a local delete while no sync is running for an account yet (app
 * start, sign-in in progress). The next TableSync for any account picks it up.
 * Ids are UUIDs (settings: keys of this device), so a delete can only ever
 * hit the row it was made for.
 */
export async function queuePendingDelete(storage: SyncStorage, table: SyncTable, id: string, deletedAt = Date.now()): Promise<void> {
  const box = parseOutbox(await storage.get(pendingKey(table)), () => {})
  box.set(id, Math.max(box.get(id) ?? 0, deletedAt))
  await storage.set(pendingKey(table), JSON.stringify(Object.fromEntries(box)))
}

// ─── One table ──────────────────────────────────────────────────────────────

export class TableSync<L> {
  status: SyncStatus = 'idle'
  lastResult: SyncResult | null = null
  private outbox: Outbox | null = null
  private running: Promise<SyncResult> | null = null
  private again = false
  private listeners = new Set<(r: SyncResult | null) => void>()
  private tombstonesMissingLogged = false
  private rpcDeleteMissing = false
  private rejectedLogged = new Set<string>()

  constructor(
    readonly adapter: TableAdapter<L>,
    private readonly transport: SyncTransport,
    private readonly storage: SyncStorage,
    private readonly userId: string,
  ) {}

  get table(): SyncTable { return this.adapter.table }
  get isRunning(): boolean { return this.running !== null }
  private get idCol() { return this.adapter.idColumn ?? 'id' }
  private log(...a: unknown[]) { this.transport.log?.(`[sync ${this.adapter.table}]`, ...a) }

  subscribe(fn: (r: SyncResult | null) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  /** A throwing listener (UI) must never break sync. */
  private emit(r: SyncResult | null) {
    for (const l of this.listeners) {
      try { l(r) } catch (err) { this.log('listener threw', err instanceof Error ? err.message : err) }
    }
  }

  /** Rows waiting for the server: queued deletes, plus "unknown" after a failed round. */
  async hasUnsynced(): Promise<boolean> {
    let queued = true
    try { queued = (await this.loadOutbox()).size > 0 } catch { /* unreadable: assume yes */ }
    return queued || (this.lastResult !== null && this.lastResult.status !== 'ok')
  }

  /** Remember a local delete until the server confirms it. Call after deleting locally. */
  async queueDelete(id: string, deletedAt = Date.now()): Promise<void> {
    const box = await this.loadOutbox()
    box.set(id, Math.max(box.get(id) ?? 0, deletedAt))
    await this.saveOutbox(box)
  }

  /** Resolves once no round is running. */
  async settled(): Promise<void> {
    while (this.running) await this.running.catch(() => {})
  }

  /** Run a round. Calls during a round are coalesced into one follow-up round. */
  run(): Promise<SyncResult> {
    if (this.running) { this.again = true; return this.running }
    this.running = (async () => {
      let result: SyncResult = { status: 'error', changedLocal: false, message: 'not run' }
      let changed = false
      try {
        do {
          this.again = false
          this.status = 'syncing'
          this.emit(null)
          result = await this.round()
          changed = changed || result.changedLocal
        } while (this.again && result.status === 'ok')
      } catch (err) {
        result = { status: 'error', changedLocal: changed, message: err instanceof Error ? err.message : String(err) }
      } finally {
        result = { ...result, changedLocal: changed }
        this.lastResult = result
        this.status = result.status === 'ok' ? 'idle' : result.status
        this.running = null
      }
      this.emit(result)
      return result
    })()
    return this.running
  }

  /**
   * The persisted outbox, merged with deletes queued before this account's
   * sync started. A storage read failure propagates (the round fails and is
   * retried) instead of continuing with an empty list that the next save
   * would write over the real one.
   */
  private async loadOutbox(): Promise<Outbox> {
    if (this.outbox) return this.outbox
    const box = parseOutbox(await this.storage.get(outboxKey(this.userId, this.table)), (...a) => this.log(...a))
    const pending = parseOutbox(await this.storage.get(pendingKey(this.table)), (...a) => this.log(...a))
    if (pending.size) {
      for (const [id, at] of pending) box.set(id, Math.max(box.get(id) ?? 0, at))
      await this.saveOutbox(box)
      await this.storage.remove(pendingKey(this.table))
    }
    this.outbox ??= box
    return this.outbox
  }

  private async saveOutbox(box: Outbox): Promise<void> {
    const key = outboxKey(this.userId, this.table)
    if (box.size === 0) await this.storage.remove(key)
    else await this.storage.set(key, JSON.stringify(Object.fromEntries(box)))
  }

  private async request(
    method: string, path: string,
    init: { body?: unknown; prefer?: string; timeoutMs?: number } = {},
  ): Promise<Response> {
    const doFetch = this.transport.fetch ?? fetch
    const timeoutMs = init.timeoutMs ?? this.transport.timeoutMs ?? 30_000
    for (let attempt = 0; ; attempt++) {
      const jwt = await this.transport.getJwt()
      if (!jwt) throw new OfflineError('no sync token (offline or signed out)')
      const headers: Record<string, string> = { Authorization: `Bearer ${jwt}`, Accept: 'application/json' }
      if (init.body !== undefined) headers['Content-Type'] = 'application/json'
      if (init.prefer) headers.Prefer = init.prefer
      // A hung request (flaky cell link) must not keep the round, and with it
      // sign-out, waiting forever.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      let res: Response
      try {
        res = await doFetch(`${this.transport.restBase}/${path}`, {
          method, headers, signal: ctrl.signal,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        })
        if (res.status === 401 && attempt === 0 && this.transport.invalidateJwt) {
          this.transport.invalidateJwt()
          continue
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new HttpError(res.status, `${method} ${path.split('?')[0]} ${res.status} ${text.slice(0, 200)}`)
        }
        return res
      } catch (err) {
        if (err instanceof HttpError) throw err
        const msg = ctrl.signal.aborted ? `timed out after ${timeoutMs} ms` : err instanceof Error ? err.message : String(err)
        throw new OfflineError(msg)
      } finally {
        clearTimeout(timer)
      }
    }
  }

  private async getJson<T>(path: string, timeoutMs?: number): Promise<T> {
    return (await this.request('GET', path, { timeoutMs })).json() as Promise<T>
  }

  private async fetchTombstones(): Promise<Tombstone[]> {
    try {
      const rows = await this.getJson<{ row_id: string; deleted_at: string }[]>(
        `user_sync_tombstones?table_name=eq.${this.adapter.table}&select=row_id,deleted_at`)
      return rows.map(r => ({ id: r.row_id, deletedAt: parseTs(r.deleted_at) }))
    } catch (err) {
      // A server without the tombstone migration: deletes made on another
      // device cannot be detected and those rows are uploaded again. Never
      // guess a delete instead -- that loses data.
      if (err instanceof HttpError && err.status === 404) {
        if (!this.tombstonesMissingLogged) this.log('server has no user_sync_tombstones; remote deletes are not detected')
        this.tombstonesMissingLogged = true
        return []
      }
      throw err
    }
  }

  /** Delete on the server, recording when the user deleted it. */
  private async deleteRemote(id: string, deletedAt: number): Promise<void> {
    if (!this.rpcDeleteMissing) {
      try {
        await this.request('POST', 'rpc/sync_delete', {
          body: { p_table: this.table, p_id: id, p_deleted_at: new Date(deletedAt).toISOString() },
        })
        return
      } catch (err) {
        // Server without the migration: fall back to a plain DELETE.
        if (!(err instanceof HttpError && err.status === 404)) throw err
        this.rpcDeleteMissing = true
      }
    }
    await this.request('DELETE', `${this.table}?${this.idCol}=eq.${encodeURIComponent(id)}`)
  }

  /** Upload rows; returns how many failed in a way worth retrying. */
  private async upload(rows: L[]): Promise<number> {
    const { adapter } = this
    const path = `${adapter.table}?on_conflict=${adapter.idColumn === 'key' ? 'user_id,key' : 'id'}&select=${this.idCol},updated_at`
    const prefer = `${adapter.immutable ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates'},return=representation`
    const timeoutMs = 4 * (this.transport.timeoutMs ?? 30_000)
    let failed = 0
    for (const batch of chunks(rows, adapter.uploadBatch ?? 50)) {
      try {
        const res = await this.request('POST', path, {
          body: batch.map(r => adapter.toServer(r, this.userId)), prefer, timeoutMs,
        })
        await this.adoptStored(batch, await res.json().catch(() => []) as Record<string, unknown>[])
      } catch (err) {
        if (err instanceof OfflineError) throw err
        if (batch.length > 1) {
          // One bad row fails the whole batch: retry singly to isolate it.
          for (const r of batch) failed += await this.upload([r])
          continue
        }
        const id = adapter.version(batch[0]).id
        const message = err instanceof Error ? err.message : String(err)
        if (isPermanent(err)) {
          // Retrying cannot help (row too large, schema mismatch): log it
          // once and stop counting it as unsynced.
          if (!this.rejectedLogged.has(id)) this.log('server rejected row, not retrying', id, message)
          this.rejectedLogged.add(id)
        } else {
          this.log('upload failed', id, message)
          failed++
        }
      }
    }
    return failed
  }

  /** Adopt the server's updated_at where its clock guard changed ours. */
  private async adoptStored(batch: L[], stored: Record<string, unknown>[]): Promise<void> {
    if (!this.adapter.restamp || !Array.isArray(stored)) return
    const sent = new Map(batch.map(r => { const v = this.adapter.version(r); return [v.id, v.updatedAt] }))
    const restamps: Restamp[] = []
    for (const row of stored) {
      const id = String(row[this.idCol])
      const from = sent.get(id)
      const to = parseTs(row.updated_at)
      if (from !== undefined && to && to !== from) restamps.push({ id, from, to })
    }
    if (restamps.length) {
      this.log('server clamped timestamps (device clock ahead?)', restamps.length)
      await this.adapter.restamp(restamps)
    }
  }

  private async round(): Promise<SyncResult> {
    const { adapter } = this
    let changedLocal = false
    try {
      // 1. Deletes made on this device.
      const box = await this.loadOutbox()
      for (const [id, deletedAt] of [...box]) {
        try {
          await this.deleteRemote(id, deletedAt)
        } catch (err) {
          // A permanent client error (e.g. an id the server can never hold)
          // would block the outbox forever; anything else is retried.
          if (!isPermanent(err)) throw err
          this.log('dropping undeletable id', id, err instanceof Error ? err.message : err)
        }
        box.delete(id)
        await this.saveOutbox(box)
      }

      // 2. Server state.
      const serverRows = await this.getJson<Record<string, unknown>[]>(
        `${adapter.table}?select=${this.idCol},updated_at`)
      const server = serverRows.map(r => ({ id: String(r[this.idCol]), updatedAt: parseTs(r.updated_at) }))
      const tombstones = await this.fetchTombstones()
      const local = await adapter.list()

      // 3. Plan.
      const plan = planSync({
        local, version: l => adapter.version(l), server, tombstones,
        pendingDeletes: box, immutable: adapter.immutable,
        canUpload: adapter.canUpload ? l => adapter.canUpload!(l) : undefined,
      })

      // 4. Apply.
      if (plan.removeLocal.length) {
        await adapter.remove(plan.removeLocal)
        changedLocal = true
      }
      for (const ids of chunks(plan.download, adapter.downloadBatch ?? 50)) {
        const rows = await this.getJson<Record<string, unknown>[]>(
          `${adapter.table}?${this.idCol}=in.${encodeURIComponent(inList(ids))}&select=*`,
          4 * (this.transport.timeoutMs ?? 30_000))
        // A delete queued while this round ran must not be undone.
        const docs = rows
          .map(r => adapter.fromServer(r))
          .filter((d): d is L => d !== null && !box.has(adapter.version(d).id))
        if (docs.length) {
          await adapter.apply(docs)
          changedLocal = true
        }
      }
      const failed = plan.upload.length ? await this.upload(plan.upload) : 0

      if (plan.download.length || plan.upload.length || plan.removeLocal.length) {
        this.log(`down ${plan.download.length}, up ${plan.upload.length - failed}/${plan.upload.length}, removed ${plan.removeLocal.length}`)
      }
      return failed
        ? { status: 'error', changedLocal, message: `${failed} upload(s) failed` }
        : { status: 'ok', changedLocal }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(err instanceof OfflineError ? 'offline:' : 'failed:', message)
      return { status: err instanceof OfflineError ? 'offline' : 'error', changedLocal, message }
    }
  }
}

// ─── All tables of one signed-in account ────────────────────────────────────

export interface CoordinatorOptions {
  /** Poll for changes made elsewhere (ms). */
  periodMs?:   number
  /** Delay after a local change, so a burst of edits becomes one round. */
  debounceMs?: number
  retryMinMs?: number
  retryMaxMs?: number
}

export class SyncCoordinator {
  private timers = new Map<SyncTable, ReturnType<typeof setTimeout>>()
  private retryDelay = new Map<SyncTable, number>()
  private periodic: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private listeners = new Set<() => void>()
  private readonly opts: Required<CoordinatorOptions>
  readonly tables: Map<SyncTable, TableSync<unknown>>

  constructor(tables: TableSync<unknown>[], opts: CoordinatorOptions = {}) {
    this.opts = {
      periodMs:   opts.periodMs   ?? 5 * 60_000,
      debounceMs: opts.debounceMs ?? 1_500,
      retryMinMs: opts.retryMinMs ?? 15_000,
      retryMaxMs: opts.retryMaxMs ?? 5 * 60_000,
    }
    this.tables = new Map(tables.map(t => [t.table, t]))
    for (const t of tables) t.subscribe(() => this.emit())
  }

  get<L>(table: SyncTable): TableSync<L> | undefined {
    return this.tables.get(table) as TableSync<L> | undefined
  }

  /** Overall state for a status indicator: worst of all tables. */
  get status(): SyncStatus {
    const all = [...this.tables.values()].map(t => t.status)
    if (all.includes('syncing')) return 'syncing'
    if (all.includes('error')) return 'error'
    if (all.includes('offline')) return 'offline'
    return 'idle'
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  private emit() {
    for (const l of this.listeners) {
      try { l() } catch { /* a UI listener must never break sync */ }
    }
  }

  start(): void {
    if (this.periodic || this.stopped) return
    this.periodic = setInterval(() => { void this.syncAll() }, this.opts.periodMs)
    void this.syncAll()
  }

  /**
   * Stop scheduling rounds. The returned promise resolves once rounds already
   * running have finished (every request has a timeout), so local data can
   * safely be wiped afterwards.
   */
  stop(): Promise<void> {
    this.stopped = true
    if (this.periodic) clearInterval(this.periodic)
    this.periodic = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    return Promise.all([...this.tables.values()].map(t => t.settled())).then(() => {})
  }

  /** A local change: sync that table soon. */
  requestSync(table: SyncTable, delayMs = this.opts.debounceMs): void {
    if (this.stopped || !this.tables.has(table)) return
    const existing = this.timers.get(table)
    if (existing) clearTimeout(existing)
    this.timers.set(table, setTimeout(() => {
      this.timers.delete(table)
      void this.syncTable(table)
    }, delayMs))
  }

  async syncTable(table: SyncTable): Promise<SyncResult | null> {
    const t = this.tables.get(table)
    if (!t || this.stopped) return null
    // Callers joining a round already in flight share its result; only the
    // caller that started it schedules the retry, so one failed round
    // advances the backoff once.
    const joined = t.isRunning
    const r = await t.run()
    if (this.stopped || joined) return r
    if (r.status === 'ok') {
      this.retryDelay.delete(table)
    } else {
      const delay = this.retryDelay.get(table) ?? this.opts.retryMinMs
      this.retryDelay.set(table, Math.min(delay * 2, this.opts.retryMaxMs))
      this.requestSync(table, delay)
    }
    return r
  }

  /** Sync every table now (app start, foreground, back online, pull-to-refresh). */
  async syncAll(): Promise<boolean> {
    const results = await Promise.all([...this.tables.keys()].map(t => this.syncTable(t)))
    return results.every(r => r === null || r.status === 'ok')
  }

  /** True when something local may not have reached the server yet. */
  async hasUnsynced(): Promise<boolean> {
    for (const t of this.tables.values()) if (await t.hasUnsynced()) return true
    return false
  }
}
