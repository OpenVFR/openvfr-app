import { LAYER_GROUPS } from '../styles/map-style'
import type { TerrainColoringSettings } from '../db/useSettings'
import css from './LayerPanel.module.css'

interface Props {
  visibility: Record<string, boolean>
  onChange: (groupId: string, on: boolean) => void
  terrainColoring: TerrainColoringSettings
  onTerrainColoringChange: (v: TerrainColoringSettings) => void
  /** True when aircraft is airborne (GS ≥ 30 kts); ref-alt input is locked. */
  inFlight?: boolean
}

export default function LayerPanel({ visibility, onChange, terrainColoring, onTerrainColoringChange, inFlight }: Props) {
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
            {/* Terrain colour bands (relative to reference altitude) — grouped
                with the other Terrain filters rather than global Settings,
                since it's a map-overlay toggle like the rows above it. */}
            {group.id === 'contours' && (
              <div>
                <button
                  type="button"
                  onClick={() => onTerrainColoringChange({ ...terrainColoring, enabled: !terrainColoring.enabled })}
                  className={`${css.row} ${css.groupTerrainColor}`}
                  data-active={terrainColoring.enabled ? 'true' : 'false'}
                  title="Overlay terrain colour bands relative to reference altitude"
                >
                  <span className={css.swatch} />
                  <span className={css.label}>Terrain colour</span>
                  <span className={css.badge}>{terrainColoring.enabled ? 'ON' : 'OFF'}</span>
                </button>
                {terrainColoring.enabled && (
                <div className={css.terrainColorDetail}>
                  <span className={css.colorKey}>
                    <span className={css.ckRed}    title="< 500 ft below ref" />
                    <span className={css.ckOrange} title="500–1000 ft below" />
                    <span className={css.ckYellow} title="1000–1500 ft below" />
                    <span className={css.ckGreen}  title="> 1500 ft below" />
                  </span>
                  {inFlight
                    ? <span className={css.refAltLive}>using GPS alt</span>
                    : (
                      <>
                        <input
                          type="number"
                          className={css.refAltInput}
                          value={terrainColoring.refAltFt}
                          min={100}
                          max={30000}
                          step={100}
                          title="Reference altitude in feet MSL"
                          onChange={e => {
                            const v = parseInt(e.target.value, 10)
                            if (!isNaN(v) && v > 0) onTerrainColoringChange({ ...terrainColoring, refAltFt: v })
                          }}
                        />
                        <span className={css.refAltUnit}>ft</span>
                      </>
                    )
                  }
                </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
