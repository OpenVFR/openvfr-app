// Thin client for /api/admin/* (see apps/api/src/admin.ts). Session cookie only;
// the server is the sole authority on who is an admin.
import { API_BASE_URL } from '../../utils/env'

export class AdminApiError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}/api/admin${path}`, {
    credentials: 'include',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; code?: string }
    throw new AdminApiError(res.status, body.error ?? `HTTP ${res.status}`, body.code)
  }
  return res.json() as Promise<T>
}

export interface Totals {
  users: number; verified: number; new_7d: number; new_30d: number; with_passkey: number
  active_sessions: number; active_1d: number; active_7d: number; active_30d: number; banned: number
}
export interface DayCount { day: string; count: number }
export interface Overview { totals: Totals; signupsPerDay: DayCount[]; activePerDay: DayCount[] }
export interface AdminUser {
  id: string; email: string; name: string; emailVerified: boolean; createdAt: string
  passkeys: number; sessions: number; lastActive: string | null; banned: boolean; isAdmin: boolean
}
export interface UserDetail {
  user: {
    id: string; email: string; name: string; emailVerified: boolean; createdAt: string; updatedAt: string
    isAdmin: boolean; banned: boolean; banReason: string | null; banExpires: string | null
  }
  sessions: { id: string; createdAt: string; updatedAt: string; expiresAt: string; userAgent: string | null }[]
  passkeys: { id: string; name: string | null; deviceType: string | null; backedUp: boolean; createdAt: string }[]
}

export const adminApi = {
  me:       () => call<{ email: string }>('/me'),
  overview: () => call<Overview>('/overview'),
  users:    (q: string, sort: string, offset: number, limit: number, banned: boolean) =>
    call<{ total: number; users: AdminUser[] }>(
      `/users?${new URLSearchParams({ q, sort, offset: String(offset), limit: String(limit), ...(banned ? { banned: '1' } : {}) })}`),
  user:     (id: string) => call<UserDetail>(`/users/${encodeURIComponent(id)}`),
  ban:      (id: string, reason: string, days?: number) =>
    call<{ ok: true }>(`/users/${encodeURIComponent(id)}/ban`, { method: 'POST', body: JSON.stringify({ reason, days }) }),
  unban:    (id: string) => call<{ ok: true }>(`/users/${encodeURIComponent(id)}/unban`, { method: 'POST' }),
}
