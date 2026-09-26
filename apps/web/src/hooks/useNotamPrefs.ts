/**
 * NOTAM display preferences, persisted in localStorage and kept in sync
 * across every mounted consumer (popup, panels, map) via a window event:
 *   textView -- Short / Full / Raw text (see @open-vfr/shared/notamIcaoFormat)
 *   vfrOnly  -- hide IFR-only NOTAMs (default on; see notamRelevance.ts)
 */
import { useCallback, useEffect, useState } from 'react'
import type { NotamTextView } from '@open-vfr/shared/notamIcaoFormat'

const K_VIEW = 'ovfr:notamTextView'
const K_VFR = 'ovfr:notamVfrOnly'
const EVT = 'ovfr:notam-prefs'

const readView = (): NotamTextView => {
  const v = localStorage.getItem(K_VIEW)
  return v === 'short' || v === 'raw' ? v : 'full'
}
const readVfr = (): boolean => localStorage.getItem(K_VFR) !== '0'

/** Subscribes to the VFR-only flag alone -- for heavy consumers (MapView)
 *  that must not re-render when only the text view changes. */
export function useNotamVfrOnly(): boolean {
  const [vfrOnly, setVfr] = useState<boolean>(readVfr)
  useEffect(() => {
    const sync = () => setVfr(readVfr())
    window.addEventListener(EVT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener('storage', sync) }
  }, [])
  return vfrOnly
}

export function useNotamPrefs() {
  const [textView, setView] = useState<NotamTextView>(readView)
  const [vfrOnly, setVfr] = useState<boolean>(readVfr)

  useEffect(() => {
    const sync = () => { setView(readView()); setVfr(readVfr()) }
    window.addEventListener(EVT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener('storage', sync) }
  }, [])

  const setTextView = useCallback((v: NotamTextView) => {
    localStorage.setItem(K_VIEW, v)
    window.dispatchEvent(new Event(EVT))
  }, [])
  const setVfrOnly = useCallback((on: boolean) => {
    localStorage.setItem(K_VFR, on ? '1' : '0')
    window.dispatchEvent(new Event(EVT))
  }, [])

  return { textView, setTextView, vfrOnly, setVfrOnly }
}
