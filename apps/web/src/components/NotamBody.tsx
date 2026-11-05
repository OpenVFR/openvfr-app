/**
 * NOTAM text with tappable coordinates: every coordinate the shared scanner
 * finds is a button that marks its point on the map (see
 * @open-vfr/shared/notamCoordinateFocus; MapView draws the marker).
 * Renders inline, so it drops into any element that shows NOTAM text.
 */
import { useMemo } from 'react'
import { splitNotamTextCoordinates } from '@open-vfr/shared/notamTextSegments'
import { focusNotamCoordinate } from '@open-vfr/shared/notamCoordinateFocus'
import css from './NotamBody.module.css'

export default function NotamBody({ text }: { text: string }) {
  const segments = useMemo(() => splitNotamTextCoordinates(text), [text])
  return (
    <>
      {segments.map((s, i) => s.kind === 'text'
        ? <span key={i}>{s.text}</span>
        : (
          <button
            key={i}
            type="button"
            className={css.coord}
            title="Show this point on the map"
            onClick={e => { e.stopPropagation(); focusNotamCoordinate({ lat: s.lat, lng: s.lng }) }}
          >{s.text}</button>
        ))}
    </>
  )
}
