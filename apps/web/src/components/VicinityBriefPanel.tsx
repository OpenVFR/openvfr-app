/**
 * VicinityBriefPanel — web counterpart to native's VicinityBriefSheet.tsx.
 * Manual aerodrome picker (candidate list from useVicinityAerodromes.ts:
 * route-buffer > GPS-radius > home-airfield fallback) with the selected
 * aerodrome's full Info/Wx/NOTAM tabs embedded below via the SAME
 * AerodromePopup component the map's click-to-open popup uses -- no
 * parallel Wx/NOTAM fetch-and-render logic, just a different lat/lng/props
 * source (a picked vicinity aerodrome instead of a map click).
 *
 * Deliberately does NOT reproduce native's separate flat-list "Freq" tab
 * (every nearby aerodrome's frequencies in one list, no picker) -- web's
 * AerodromePopup Info tab already lists the SELECTED aerodrome's own
 * frequencies; switching the picker surfaces another aerodrome's list.
 * Kept as an intentional scope simplification rather than a parallel
 * frequency-list feature with its own render path.
 */

import { useEffect, useState } from 'react'
import css from './VicinityBriefPanel.module.css'
import AerodromePopup from './AerodromePopup'
import type { VicinityAerodrome } from '../hooks/useVicinityAerodromes'
import type { RunwayWindEnd } from '@open-vfr/shared/runwayWind'

interface Props {
  aerodromes: VicinityAerodrome[]
  isHome:     (icao: string) => boolean
  authed:     boolean
  onSetHome:  (icao: string, name: string, lng: number, lat: number) => void
  onRunwayWind?: (icao: string, ends: RunwayWindEnd[]) => void
}

export default function VicinityBriefPanel({ aerodromes, isHome, authed, onSetHome, onRunwayWind }: Props) {
  const [selectedIcao, setSelectedIcao] = useState<string | null>(null)

  useEffect(() => {
    if (aerodromes.length === 0) { setSelectedIcao(null); return }
    setSelectedIcao((prev) => (prev && aerodromes.some((a) => a.icao === prev)) ? prev : aerodromes[0].icao)
  }, [aerodromes])

  if (aerodromes.length === 0) {
    return <div className={css.empty}>No aerodromes nearby. Set a home airfield in Settings, load a route, or enable GPS.</div>
  }

  const selected = aerodromes.find((a) => a.icao === selectedIcao) ?? aerodromes[0]

  return (
    <div className={css.panel}>
      <div className={css.picker}>
        {aerodromes.map((a) => (
          <button
            key={a.icao}
            className={`${css.pill} ${a.icao === selected.icao ? css.pillActive : ''}`}
            onClick={() => setSelectedIcao(a.icao)}
            title={a.name}
          >
            {a.icao}
            <span className={css.dist}>{a.distNm < 0.5 ? 'home' : `${a.distNm.toFixed(0)}NM`}</span>
          </button>
        ))}
      </div>
      <div className={css.embedded}>
        <AerodromePopup
          key={selected.icao}
          props={selected.props}
          lng={selected.lng}
          lat={selected.lat}
          isHome={isHome(selected.icao)}
          authed={authed}
          onSetHome={onSetHome}
          onClose={() => { /* embedded, no close affordance */ }}
          onRunwayWind={onRunwayWind}
        />
      </div>
    </div>
  )
}
