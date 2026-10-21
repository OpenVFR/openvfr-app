/**
 * Height of the Virtual Radar chart, user-adjustable by dragging the grip on
 * top of the whole bottom pane (instruments, sim buttons, ruler strip and the
 * chart together). A tiny external store so the grip (MapView) and the chart
 * (VirtualRadar) share one value; persisted in localStorage.
 */
import { useSyncExternalStore } from 'react'

export const DEFAULT_CHART_H = 162
export const MIN_CHART_H = 100
export const MAX_CHART_H = 520
const KEY = 'ovfr.vr.chartH'

export const clampChartH = (h: number) => Math.max(MIN_CHART_H, Math.min(MAX_CHART_H, Math.round(h)))

function load(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    return v > 0 ? clampChartH(v) : DEFAULT_CHART_H
  } catch { return DEFAULT_CHART_H }
}

let height = load()
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export function setChartH(h: number, persist = false): void {
  height = clampChartH(h)
  listeners.forEach((fn) => fn())
  if (persist) { try { localStorage.setItem(KEY, String(height)) } catch { /* ignore */ } }
}

export function resetChartH(): void {
  height = DEFAULT_CHART_H
  listeners.forEach((fn) => fn())
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}

export const useChartH = (): number => useSyncExternalStore(subscribe, () => height, () => DEFAULT_CHART_H)
export const getChartH = (): number => height
