import { LAYER_GROUPS } from '../styles/map-style'
import css from './LayerPanel.module.css'

interface Props {
  visibility: Record<string, boolean>
  onChange: (groupId: string, on: boolean) => void
}

export default function LayerPanel({ visibility, onChange }: Props) {
  let lastSection = ''
  let isFirstSection = true
  return (
    <div className={css.panel}>
      {LAYER_GROUPS.map((group) => {
        const on = visibility[group.id] ?? group.defaultOn
        const groupColorClass = css[group.cssClass as keyof typeof css]
        const showSection = group.section !== lastSection
        const firstSection = showSection && isFirstSection
        if (showSection) { lastSection = group.section; isFirstSection = false }
        return (
          <div key={group.id}>
            {showSection && (
              <div className={`${css.section}${firstSection ? ` ${css.sectionFirst}` : ''}`}>{group.section}</div>
            )}
            <button
              type="button"
              onClick={() => onChange(group.id, !on)}
              className={`${css.row} ${groupColorClass}`}
              data-active={on ? 'true' : 'false'}
              title={group.label}
            >
              <span className={css.swatch} />
              <span className={css.label}>{group.label}</span>
              <span className={css.badge}>{on ? 'ON' : 'OFF'}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
