/**
 * The pilot's read / hidden marks on NOTAMs (see @open-vfr/shared/notamTriage),
 * persisted in localStorage and kept in sync across mounted consumers.
 */
import { useCallback, useEffect, useState } from 'react'
import { EMPTY_TRIAGE, hide, markRead, parseTriage, unhide, type NotamTriage } from '@open-vfr/shared/notamTriage'

const KEY = 'ovfr:notamTriage'
const EVT = 'ovfr:notam-triage'

/** Used only when localStorage is unavailable (private mode, quota): marks then last until the page closes. */
let memory: NotamTriage | null = null

function read(): NotamTriage {
  if (memory) return memory
  try { return parseTriage(localStorage.getItem(KEY)) } catch { return EMPTY_TRIAGE }
}

function write(t: NotamTriage) {
  try { localStorage.setItem(KEY, JSON.stringify(t)); memory = null } catch { memory = t }
  window.dispatchEvent(new Event(EVT))
}

export function useNotamTriage() {
  const [triage, setTriage] = useState<NotamTriage>(read)
  useEffect(() => {
    const sync = () => setTriage(read())
    window.addEventListener(EVT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener('storage', sync) }
  }, [])
  const setRead = useCallback((key: string) => { const t = read(); const n = markRead(t, key); if (n !== t) write(n) }, [])
  const setHidden = useCallback((key: string) => write(hide(read(), key)), [])
  const setShown = useCallback((key: string) => write(unhide(read(), key)), [])
  return { triage, markRead: setRead, hide: setHidden, unhide: setShown }
}
