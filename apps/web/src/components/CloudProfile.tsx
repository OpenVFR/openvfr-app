/**
 * CloudProfile — vertical cloud-layer altitude chart.
 *
 * Visual parity target: public METAR/TAF sites plot cloud layers on a
 * vertical ft-scale with an icon at each layer's base, instead of a plain
 * text list. Adapted (not cloned) to this app's narrow side-panel width: a
 * compact vertical strip with gridlines every 1,000 ft and a small cloud
 * icon + cover/altitude label at each reported layer, sized to sit under
 * the Wx tab's tile grid.
 */

import css from './CloudProfile.module.css'
import type { ParsedCloudLayer } from '@open-vfr/shared/fetchWx'

interface Props {
  clouds: ParsedCloudLayer[]
}

const COVER_LABEL: Record<ParsedCloudLayer['cover'], string> = {
  FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast',
}

export default function CloudProfile({ clouds }: Props) {
  if (clouds.length === 0) return null

  const maxFt = Math.max(...clouds.map((l) => l.baseFt))
  const topFt = Math.max(3000, Math.ceil((maxFt * 1.15) / 1000) * 1000)
  const gridlines: number[] = []
  for (let ft = 0; ft <= topFt; ft += 1000) gridlines.push(ft)

  const sorted = [...clouds].sort((a, b) => a.baseFt - b.baseFt)

  return (
    <div className={css.chart}>
      <div className={css.plot}>
        {gridlines.map((ft) => (
          <div key={ft} className={css.gridline} style={{ bottom: `${(ft / topFt) * 100}%` }}>
            <span className={css.gridLabel}>{ft === 0 ? 'GND' : `${(ft / 1000).toFixed(0)}k`}</span>
          </div>
        ))}
        {sorted.map((layer, i) => (
          <div key={i} className={css.layer} style={{ bottom: `${(layer.baseFt / topFt) * 100}%` }}>
            <svg viewBox="0 0 24 24" className={`${css.layerIcon} ${css[`cover${layer.cover}`]}`}>
              <path d="M6 18 a3.5 3.5 0 0 1 0.3 -6.98 A4.5 4.5 0 0 1 15 10.2 A3.2 3.2 0 0 1 18 18 Z" />
            </svg>
            <span className={css.layerLabel}>{COVER_LABEL[layer.cover]} {layer.baseFt.toLocaleString()} ft</span>
          </div>
        ))}
      </div>
    </div>
  )
}
