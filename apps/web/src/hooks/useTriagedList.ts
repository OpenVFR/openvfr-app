/**
 * A NOTAM list with the pilot's read / hidden marks applied (see @open-vfr/shared/notamTriage):
 * `rows` is what to draw, in order (the shown NOTAMs, then the hidden ones while "Show" is on).
 */
import { useCallback, useMemo, useState } from 'react'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { canHideNotam, splitHidden, triageKey } from '@open-vfr/shared/notamTriage'
import { useNotamTriage } from './useNotamTriage'

type N = Pick<NotamItem, 'nmsId' | 'effective' | 'qCode' | 'text'>

export interface TriagedRow<T> { n: T; hidden: boolean; read: boolean; canHide: boolean; key: string }

export function useTriagedList<T extends N>(notams: readonly T[]) {
  const { triage, markRead, hide, unhide } = useNotamTriage()
  const [showHidden, setShowHidden] = useState(false)
  const { rows, hiddenCount } = useMemo(() => {
    const { shown, hidden } = splitHidden(notams, triage)
    const readSet = new Set(triage.read)
    const row = (n: T, isHidden: boolean): TriagedRow<T> => {
      const key = triageKey(n)
      return { n, hidden: isHidden, read: readSet.has(key), canHide: canHideNotam(n), key }
    }
    return {
      rows: [...shown.map((n) => row(n, false)), ...(showHidden ? hidden.map((n) => row(n, true)) : [])],
      hiddenCount: hidden.length,
    }
  }, [notams, triage, showHidden])
  const toggleHidden = useCallback((r: TriagedRow<T>) => (r.hidden ? unhide(r.key) : hide(r.key)), [hide, unhide])
  const toggleShowHidden = useCallback(() => setShowHidden((v) => !v), [])
  return { rows, hiddenCount, showHidden, toggleShowHidden, markRead, toggleHidden }
}
