/**
 * fetchNotams — NOTAM fetch + date formatter.
 * Shared between web and native. Pass baseUrl='' for web; API_BASE for native.
 */

import { fetchWithRetry } from './fetchWithRetry'

export interface NotamItem {
  id:             string
  text:           string
  effective:      string | null
  expires:        string | null
  classification: string | null
}

export interface NotamResult {
  notams: NotamItem[]
}

export async function fetchNotams(
  icao: string,
  baseUrl = '',
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<NotamResult> {
  const url = `${baseUrl}/api/notam?icao=${encodeURIComponent(icao)}`
  // Retries transient network blips / 502-504 -- see fetchWithRetry.ts. A
  // 503 that persists past retries still falls through to the empty-result
  // fallback below, same as before -- a single brief 503 no longer
  // masquerades as "NOTAM service unavailable" for this ICAO.
  const resp = await fetchWithRetry(url, { signal, headers })
  if (resp.status === 503) return { notams: [] }
  if (!resp.ok) throw new Error(`NOTAM fetch failed: HTTP ${resp.status}`)
  return resp.json() as Promise<NotamResult>
}

export function fmtNotamDate(iso: string | null): string | null {
  if (!iso) return null
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    const day   = d.getUTCDate().toString().padStart(2, '0')
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]
    const hh    = d.getUTCHours().toString().padStart(2, '0')
    const mm    = d.getUTCMinutes().toString().padStart(2, '0')
    return `${day} ${month} ${hh}:${mm}Z`
  } catch {
    return iso
  }
}
