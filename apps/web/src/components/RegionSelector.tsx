/**
 * src/components/RegionSelector.tsx
 *
 * Dropdown that lets the user pick a European country/region.
 * The selected country code is passed to `onChange`; MapView updates the
 * osm-landuse tile source URL accordingly.
 */

import css from './RegionSelector.module.css'

export { EUROPEAN_REGIONS, type Region } from '@open-vfr/shared/regions'
import { EUROPEAN_REGIONS } from '@open-vfr/shared/regions'

interface Props {
  value: string
  onChange: (code: string) => void
  disabled?: boolean
}

export default function RegionSelector({ value, onChange, disabled }: Props) {
  return (
    <div className={css.container}>
      <select
        id="region-select"
        className={css.select}
        title={disabled ? 'Not available during flight' : 'Select region'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        {EUROPEAN_REGIONS.map((r) => (
          <option key={r.code} value={r.code}>
            {r.name}
          </option>
        ))}
      </select>
    </div>
  )
}
