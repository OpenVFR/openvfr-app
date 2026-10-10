/**
 * src/components/RegionSelector.tsx
 *
 * Country picker for Settings: the countries the server serves
 * (GET /api/countries via useCountries). Currently one country at a time
 * (MAX_SELECTED_COUNTRIES), shown as radio buttons; the selection is
 * already a list, so raising the limit turns these into checkboxes.
 */

import type { AvailableCountry } from '@open-vfr/shared/countries'
import { toggleCountry, MAX_SELECTED_COUNTRIES } from '@open-vfr/shared/countries'
import css from './RegionSelector.module.css'

interface Props {
  /** null = list not loaded yet (first start offline). */
  countries: AvailableCountry[] | null
  selected: string[]
  onChange: (codes: string[]) => void
  disabled?: boolean
}

const SINGLE = MAX_SELECTED_COUNTRIES === 1

export default function RegionSelector({ countries, selected, onChange, disabled }: Props) {
  if (!countries) return <span className={css.note}>Country list not loaded yet</span>
  if (countries.length === 0) return <span className={css.note}>No countries available</span>
  return (
    <div className={css.container} role={SINGLE ? 'radiogroup' : 'group'} aria-label="Country">
      {countries.map((c) => {
        const checked = selected.includes(c.code)
        return (
          <label key={c.code} className={css.option} title={disabled ? 'Not available during flight' : undefined}>
            <input
              type={SINGLE ? 'radio' : 'checkbox'}
              name="country"
              checked={checked}
              // Multi-select: the last selected country can't be cleared.
              disabled={disabled || (!SINGLE && checked && selected.length === 1)}
              onChange={() => onChange(toggleCountry(selected, c.code))}
            />
            {c.name}
          </label>
        )
      })}
    </div>
  )
}
