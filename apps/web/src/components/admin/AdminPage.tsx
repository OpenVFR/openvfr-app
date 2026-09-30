import { useCallback, useEffect, useState } from 'react'
import { adminApi, AdminApiError, type AdminUser, type DayCount, type Overview, type UserDetail } from './adminApi'
import s from './AdminPage.module.css'

const PAGE_SIZE = 50

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

function Bars({ data }: { data: DayCount[] }) {
  const max = Math.max(1, ...data.map(d => d.count))
  return (
    <div className={s.bars}>
      {data.map(d => (
        <div key={d.day} className={s.bar} style={{ height: `${(d.count / max) * 100}%` }} title={`${d.day}: ${d.count}`} />
      ))}
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: number }) {
  return <div className={s.kpi}><div className={s.kpiValue}>{value}</div><div className={s.kpiLabel}>{label}</div></div>
}

export default function AdminPage() {
  // 'checking' -> 'ok' | 'signin' (401) | 'denied' (403/404 -- indistinguishable on purpose)
  const [gate, setGate] = useState<'checking' | 'ok' | 'signin' | 'denied'>('checking')
  const [adminEmail, setAdminEmail] = useState('')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [bannedOnly, setBannedOnly] = useState(false)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('created')
  const [offset, setOffset] = useState(0)
  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const loadUsers = useCallback(async () => {
    const r = await adminApi.users(q, sort, offset, PAGE_SIZE, bannedOnly)
    setUsers(r.users); setTotal(r.total)
  }, [q, sort, offset, bannedOnly])

  const loadAll = useCallback(async () => {
    setOverview(await adminApi.overview())
    await loadUsers()
  }, [loadUsers])

  useEffect(() => {
    adminApi.me()
      .then(m => { setAdminEmail(m.email); setGate('ok') })
      .catch((e: unknown) => setGate(e instanceof AdminApiError && e.status === 401 ? 'signin' : 'denied'))
  }, [])

  useEffect(() => {
    if (gate !== 'ok') return
    const t = setTimeout(() => { loadAll().catch(e => setError(String(e.message ?? e))) }, 250)
    return () => clearTimeout(t)
  }, [gate, loadAll])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await fn(); await loadAll(); if (detail) setDetail(await adminApi.user(detail.user.id)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const ban = (u: { id: string; email: string }) => {
    const reason = window.prompt(`Ban ${u.email}? All sessions are revoked and sign-in is blocked.
Reason (optional):`)
    if (reason === null) return
    const daysRaw = window.prompt('Ban duration in days (leave empty for permanent):', '')
    if (daysRaw === null) return
    const days = daysRaw.trim() === '' ? undefined : Number(daysRaw)
    if (days !== undefined && !(days > 0)) { setError('Invalid number of days'); return }
    void run(() => adminApi.ban(u.id, reason, days))
  }

  if (gate === 'checking') return <div className={`${s.page} ${s.center}`}>Loading…</div>
  if (gate === 'signin') {
    return <div className={`${s.page} ${s.center}`}><span>Sign in first: <a className={s.link} href="/">open the app</a>, then reload this page.</span></div>
  }
  if (gate === 'denied') return <div className={`${s.page} ${s.center}`}>Not found</div>

  const t = overview?.totals
  return (
    <div className={s.page}>
      <div className={s.wrap}>
        <div className={s.header}>
          <div className={s.title}>OpenVFR admin</div>
          <div className={s.muted}>{adminEmail} · <a className={s.link} href="/">back to app</a></div>
        </div>
        {error && <div className={s.error}>{error}</div>}

        {t && (
          <div className={s.kpis}>
            <Kpi label="Users" value={t.users} />
            <Kpi label="Email verified" value={t.verified} />
            <Kpi label="New (7d)" value={t.new_7d} />
            <Kpi label="New (30d)" value={t.new_30d} />
            <Kpi label="Active (24h)" value={t.active_1d} />
            <Kpi label="Active (7d)" value={t.active_7d} />
            <Kpi label="Active (30d)" value={t.active_30d} />
            <Kpi label="Live sessions" value={t.active_sessions} />
            <Kpi label="With passkey" value={t.with_passkey} />
            <Kpi label="Banned users" value={t.banned} />
          </div>
        )}

        {overview && (
          <div className={s.charts}>
            <div className={s.chart}><div className={s.chartTitle}>Signups / day (30d)</div><Bars data={overview.signupsPerDay} /></div>
            <div className={s.chart}><div className={s.chartTitle}>Active users / day (30d)</div><Bars data={overview.activePerDay} /></div>
          </div>
        )}
        <div className={s.muted}>“Active” = users whose session was created or refreshed in the window (a proxy for logins/usage).</div>

        <div className={s.section}>
          <div className={s.sectionTitle}>Users ({total})</div>
          <div className={s.toolbar}>
            <input className={s.input} placeholder="Search email or name" value={q}
              onChange={e => { setQ(e.target.value); setOffset(0) }} />
            <select className={s.select} value={sort} onChange={e => { setSort(e.target.value); setOffset(0) }}>
              <option value="created">Newest</option>
              <option value="lastActive">Last active</option>
              <option value="email">Email A–Z</option>
            </select>
            <label className={s.muted}><input type="checkbox" checked={bannedOnly} onChange={e => { setBannedOnly(e.target.checked); setOffset(0) }} /> Banned only</label>
            <div className={s.pager}>
              <button className={s.btn} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Prev</button>
              <span className={s.muted}>{total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE_SIZE, total)}</span>
              <button className={s.btn} disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
            </div>
          </div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th>Email</th><th>Name</th><th>Created</th><th>Last active</th><th>Sessions</th><th>Passkeys</th><th /></tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className={s.row} onClick={() => { adminApi.user(u.id).then(setDetail).catch(e => setError(e.message)) }}>
                    <td>{u.email}</td><td>{u.name}</td><td>{fmt(u.createdAt)}</td><td>{fmt(u.lastActive)}</td>
                    <td>{u.sessions}</td><td>{u.passkeys}</td>
                    <td>
                      {u.isAdmin && <span className={`${s.badge} ${s.badgeAdmin}`}>admin</span>}
                      {u.banned && <span className={`${s.badge} ${s.badgeBanned}`}>banned</span>}
                      {!u.emailVerified && <span className={s.badge}>unverified</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {detail && (
          <div className={s.detail}>
            <div className={s.detailHead}>
              <div><b>{detail.user.email}</b> <span className={s.muted}>{detail.user.name}</span></div>
              <div>
                {detail.user.banned
                  ? <button className={s.btn} disabled={busy} onClick={() => void run(() => adminApi.unban(detail.user.id))}>Unban</button>
                  : !detail.user.isAdmin && <button className={`${s.btn} ${s.danger}`} disabled={busy} onClick={() => ban(detail.user)}>Ban user</button>}
                {' '}<button className={s.btn} onClick={() => setDetail(null)}>Close</button>
              </div>
            </div>
            <div className={s.muted}>Created {fmt(detail.user.createdAt)} · verified {String(detail.user.emailVerified)}</div>
            {detail.user.banned && <div className={s.error}>Banned{detail.user.banReason && ` — ${detail.user.banReason}`}{detail.user.banExpires ? ` until ${fmt(detail.user.banExpires)}` : ' (permanent)'}</div>}
            <div><b>Passkeys</b> ({detail.passkeys.length}): {detail.passkeys.map(p => `${p.name ?? 'unnamed'} (${p.deviceType ?? '?'}, ${fmt(p.createdAt)})`).join('; ') || '—'}</div>
            <div><b>Sessions</b> ({detail.sessions.length})</div>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead><tr><th>Created</th><th>Last seen</th><th>Expires</th><th>User agent</th></tr></thead>
                <tbody>
                  {detail.sessions.map(x => (
                    <tr key={x.id}><td>{fmt(x.createdAt)}</td><td>{fmt(x.updatedAt)}</td><td>{fmt(x.expiresAt)}</td><td>{x.userAgent ?? '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
