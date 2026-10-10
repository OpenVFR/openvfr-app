/**
 * src/components/RegionSelector.tsx
 *
 * Country picker for Settings: one checkbox per country the server serves
 * (GET /api/countries via useCountries). Several can be selected; at least
 * one always stays selected. The selection scopes country-specific data
 * (regional NOTAMs; map data per country as it becomes available).
 */

import type { AvailableCountry } from '@open-vfr/shared/countries'
import { toggleCountry } from '@open-vfr/shared/countries'
import css from './RegionSelector.module.css'

interface Props {
  /** null = list not loaded yet (first start offline). */
  countries: AvailableCountry[] | null
  selected: string[]
  onChange: (codes: string[]) => void
  disabled?: boolean
}

export default function RegionSelector({ countries, selected, onChange, disabled }: Props) {
  if (!countries) return <span className={css.note}>Country list not loaded yet</span>
  if (countries.length === 0) return <span className={css.note}>No countries available</span>
  return (
    <div className={css.container} role="group" aria-label="Countries">
      {countries.map((c) => {
        const checked = selected.includes(c.code)
        return (
          <label key={c.code} className={css.option} title={disabled ? 'Not available during flight' : undefined}>
            <input
              type="checkbox"
              checked={checked}
              // The last selected country can't be cleared.
              disabled={disabled || (checked && selected.length === 1)}
              onChange={() => onChange(toggleCountry(selected, c.code))}
            />
            {c.name}
          </label>
        )
      })}
    </div>
  )
}
