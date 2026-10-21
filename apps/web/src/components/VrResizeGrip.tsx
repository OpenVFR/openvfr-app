import { getChartH, setChartH, resetChartH } from '../utils/vrChartHeight'
import css from './VrResizeGrip.module.css'

/** Splitter on top of the bottom pane: drag up = taller Virtual Radar chart. */
export default function VrResizeGrip() {
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY, startH = getChartH()
    let last = startH
    const move = (ev: PointerEvent) => { last = startH + (startY - ev.clientY); setChartH(last) }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setChartH(last, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  return (
    <div
      className={css.grip}
      onPointerDown={onDown}
      onDoubleClick={resetChartH}
      title="Drag to resize the bottom pane (double-click to reset)"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize bottom pane"
    />
  )
}
