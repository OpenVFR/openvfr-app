/**
 * fetchWx — METAR/TAF fetch + METAR decoder.
 * Shared between web and native. Pass baseUrl='' for web (relative URL via
 * Vite proxy); pass API_BASE for native (absolute URL via adb reverse or prod).
 */

import { fetchWithRetry } from './fetchWithRetry'

export interface WxResult {
  metar: string | null
  taf:   string | null
}

export async function fetchWx(
  icao: string,
  baseUrl = '',
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<WxResult> {
  const url = `${baseUrl}/api/weather?icao=${encodeURIComponent(icao)}`
  // Retries transient network blips / 502-504 -- see fetchWithRetry.ts.
  const resp = await fetchWithRetry(url, { signal, headers })
  if (!resp.ok) throw new Error(`Weather fetch failed: HTTP ${resp.status}`)
  return resp.json() as Promise<WxResult>
}

// ── METAR decoder ─────────────────────────────────────────────────────────────

export interface MetarDecoded {
  time:       string | null
  wind:       string | null
  vis:        string | null
  clouds:     string | null
  temp:       string | null
  qnh:        string | null
  wx:         string | null
  flightRule: 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null
}

export function decodeMetar(raw: string): MetarDecoded {
  const tokens = raw.split(/\s+/)

  const timeTok = tokens.find((t) => /^\d{6}Z$/.test(t))
  const time = timeTok ? timeTok.slice(2, 6).replace(/(\d{2})(\d{2})/, '$1:$2') + 'Z' : null

  const windTok = tokens.find((t) => /^(\d{3}|VRB)\d{2}(G\d{2})?(KT|MPS)$/i.test(t))
  let wind: string | null = null
  if (windTok) {
    wind = /^000(00|KT|MPS)/i.test(windTok) ? 'CALM' : windTok.toUpperCase()
  }

  const visTok = tokens.find((t) => /^\d{4}$/.test(t) || /^\d+SM$/.test(t))
  const vis = visTok ?? null

  const cavok = tokens.includes('CAVOK')
  const cloudGroups = tokens.filter((t) => /^(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)?$/i.test(t))
  const clouds = cavok ? 'CAVOK' : cloudGroups.length > 0 ? cloudGroups.join(' ') : null

  const tempTok = tokens.find((t) => /^M?\d{2}\/M?\d{2}$/.test(t))
  const temp = tempTok ?? null

  const qnhTok = tokens.find((t) => /^[QA]\d{4}$/.test(t))
  const qnh = qnhTok ?? null

  const wxCodes = tokens.filter((t) =>
    /^[-+]?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS|TS|SH|FZ|MI|BC|DR|BL)(DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG)?$/.test(t),
  )
  const wx = wxCodes.length > 0 ? wxCodes.join(' ') : null

  let flightRule: MetarDecoded['flightRule'] = null
  if (cavok) {
    flightRule = 'VFR'
  } else {
    const ceilingGroup = cloudGroups.find((g) => /^(BKN|OVC)/.test(g))
    const ceilingHft   = ceilingGroup ? parseInt(ceilingGroup.slice(3, 6), 10) * 100 : 99999
    const visM         = visTok
      ? visTok.endsWith('SM') ? parseFloat(visTok) * 1609 : parseInt(visTok, 10)
      : 99999
    if (ceilingHft < 500  || visM < 1600) flightRule = 'LIFR'
    else if (ceilingHft < 1000 || visM < 4800) flightRule = 'IFR'
    else if (ceilingHft < 3000 || visM < 8000) flightRule = 'MVFR'
    else flightRule = 'VFR'
  }

  return { time, wind, vis, clouds, temp, qnh, wx, flightRule }
}
