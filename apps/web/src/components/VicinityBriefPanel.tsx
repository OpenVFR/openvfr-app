/**
 * VicinityBriefPanel — web counterpart to native's VicinityBriefSheet.tsx.
 * Triggered by its own top-right map button (see MapView.tsx's
 * "Airfield Brief" control, stacked with Find a Destination), same
 * discoverable floating-button pattern as native's bottom-sheet trigger --
 * not tucked into the collapsible sidebar.
 *
 * Two outer tabs, matching native's own tab bar:
 *  - Frequencies: unchanged from native's own Freq tab -- flat list, every
 *    aerodrome within useNearbyFrequencies.ts's 25NM GPS radius, no picker.
 *  - Aerodrome: the useVicinityAerodromes.ts picker (route-buffer >
 *    GPS-radius > home-airfield fallback) with the selected aerodrome's
 *    full Info/Wx/NOTAM tabs embedded below via the SAME AerodromePopup
 *    component the map's click-to-open popup uses -- no parallel Wx/NOTAM
 *    fetch-and-render logic, just a different lat/lng/props source.
 *    (Native keeps Wx/NOTAM as two separate outer tabs sharing one picker;
 *    web folds them into this one tab since AerodromePopup already has its
 *    own Info/Wx/NOTAM sub-tabs -- same data, one fewer tab level.)
 */

import { useEffect, useState } from 'react'
import css from './VicinityBriefPanel.module.css'
import AerodromePopup from './AerodromePopup'
import type { VicinityAerodrome } from '../hooks/useVicinityAerodromes'
import type { NearbyAerodrome } from '../hooks/useNearbyFrequencies'
import type { RunwayWindEnd } from '@open-vfr/shared/runwayWind'

const SVC_COLOR: Record<string, string> = {
  TWR: '#3b82f6', AFIS: '#3b82f6', APP: '#8b5cf6', DEP: '#8b5cf6',
  GND: '#10b981', SMC: '#10b981', ATIS: '#f59e0b', FIS: '#06b6d4',
  INFO: '#06b6d4', RDO: '#94a3b8', RADIO: '#94a3b8', UNICOM: '#94a3b8',
}
function svcColor(svc: string) { return SVC_COLOR[svc] ?? '#94a3b8' }

type Tab = 'freq' | 'aerodrome'

interface Props {
  nearbyFreqs: NearbyAerodrome[]
  aerodromes:  VicinityAerodrome[]
  isHome:      (icao: string) => boolean
  authed:      boolean
  onSetHome:   (icao: string, name: string, lng: number, lat: number) => void
  onRunwayWind?: (icao: string, ends: RunwayWindEnd[]) => void
  onClose:     () => void
}

export default function VicinityBriefPanel({ nearbyFreqs, aerodromes, isHome, authed, onSetHome, onRunwayWind, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('freq')
  const [selectedIcao, setSelectedIcao] = useState<string | null>(null)

  useEffect(() => {
    if (aerodromes.length === 0) { setSelectedIcao(null); return }
    setSelectedIcao((prev) => (prev && aerodromes.some((a) => a.icao === prev)) ? prev : aerodromes[0].icao)
  }, [aerodromes])

  const selected = aerodromes.find((a) => a.icao === selectedIcao) ?? aerodromes[0] ?? null

  return (
    <div className={css.backdrop} onClick={onClose}>
      <div className={css.panel} onClick={(e) => e.stopPropagation()}>
        <div className={css.header}>
          <span className={css.title}>Airfield Brief</span>
          <button className={css.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={css.tabBar}>
          <button className={`${css.tab} ${tab === 'freq' ? css.tabActive : ''}`} onClick={() => setTab('freq')}>
            Frequencies{nearbyFreqs.length > 0 ? ` (${nearbyFreqs.length})` : ''}
          </button>
          <button className={`${css.tab} ${tab === 'aerodrome' ? css.tabActive : ''}`} onClick={() => setTab('aerodrome')}>
            Aerodrome{aerodromes.length > 0 ? ` (${aerodromes.length})` : ''}
          </button>
        </div>

        {tab === 'freq' && (
          <div className={css.freqList}>
            {nearbyFreqs.length === 0 ? (
              <div className={css.empty}>No aerodromes with published frequencies nearby. Enable GPS to see nearby frequencies.</div>
            ) : nearbyFreqs.map((ad) => (
              <div key={ad.icao || ad.name} className={css.adCard}>
                <div className={css.adHeader}>
                  <span className={css.adIcao}>{ad.icao}</span>
                  <span className={css.adName}>{ad.name}</span>
                  <span className={css.adDist}>{ad.distNm.toFixed(1)} NM</span>
                </div>
                {ad.frequencies.length === 0 ? (
                  <div className={css.noFreq}>No frequencies on record</div>
                ) : (
                  <div className={css.freqRows}>
                    {ad.frequencies.map((f, j) => (
                      <div key={j} className={css.freqRow}>
                        <span
                          className={css.svcBadge}
                          style={{ color: svcColor(f.service), borderColor: `${svcColor(f.service)}55`, background: `${svcColor(f.service)}22` }}
                        >
                          {f.service}
                        </span>
                        <span className={css.freqMhz}>{f.mhz.toFixed(3)}</span>
                        {f.callsign && <span className={css.freqCallsign}>{f.callsign}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === 'aerodrome' && (
          aerodromes.length === 0 ? (
            <div className={css.empty}>No aerodromes nearby. Set a home airfield in Settings, load a route, or enable GPS.</div>
          ) : selected && (
            <>
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
                  onClose={onClose}
                  onRunwayWind={onRunwayWind}
                />
              </div>
            </>
          )
        )}
      </div>
    </div>
  )
}
