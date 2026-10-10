/**
 * src/components/RegionSelector.tsx
 *
 * Country picker for Settings: a dropdown of the countries the server
 * serves (GET /api/countries via useCountries). One active country at a
 * time (MAX_SELECTED_COUNTRIES); the selection is still passed around as a
 * list so raising the limit later doesn't change any signatures.
 */

import type { AvailableCountry } from '@open-vfr/shared/countries'
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
    <select
      id="country-select"
      className={css.select}
      aria-label="Country"
      title={disabled ? 'Not available during flight' : 'Country'}
      value={selected[0] ?? ''}
      onChange={(e) => onChange([e.target.value])}
      disabled={disabled}
    >
      {countries.map((c) => (
        <option key={c.code} value={c.code}>{c.name}</option>
      ))}
    </select>
  )
}
