/**
 * VicinityBriefPanel — web counterpart to native's VicinityBriefSheet.tsx.
 * Triggered by its own top-right map button (see MapView.tsx's
 * "Airfield Brief" control, stacked with Find a Destination), same
 * discoverable floating-button pattern as native's bottom-sheet trigger --
 * not tucked into the collapsible sidebar.
 *
 * Three outer tabs, flat structure now matching native's VicinityBriefSheet.tsx
 * exactly (previously web folded Wx/NOTAM into a nested "Aerodrome" tab that
 * embedded AerodromePopup's own Info/Wx/NOTAM sub-tabs -- diverged from
 * native's shape and dropped native's "Info tab" comment intent):
 *  - Frequencies: primarily useNearbyFrequencies.ts's flat GPS-radius list
 *    (no picker), same as native -- but that hook is GPS-only, no route-
 *    buffer/home-airfield fallback tier at all, so it goes empty with no
 *    live GPS fix even with a route loaded (e.g. planning at a desk, not
 *    simulating flight) while Weather/NOTAMs below still work fine via
 *    useVicinityAerodromes.ts's route-buffer tier. Falls back to deriving
 *    the same NearbyFreq shape from `aerodromes` (useVicinityAerodromes.ts,
 *    already route/GPS/home-prioritized and along-route sorted) whenever
 *    the GPS-only list is empty, instead of leaving the tab looking broken.
 *  - Weather / NOTAMs: share one aerodrome picker (useVicinityAerodromes.ts,
 *    route-buffer > GPS-radius > home-airfield fallback), same as native.
 *    Both render via AerodromePopup's `forcedTab` prop (its Wx/NOTAM tab
 *    content with no header/tab-bar/Info tab around it) instead of
 *    duplicating that rendering into standalone files the way native's
 *    AerodromeWxSection/AerodromeNotamSection extraction did -- same
 *    content, no parallel fetch-and-render logic to keep in sync.
 *  - NOTAMs tab: AerodromePopup itself appends the FIR-wide regional list
 *    below the selected aerodrome's own NOTAMs (restricted/danger areas,
 *    navaid outages, military notices not tied to any single aerodrome) --
 *    see its own `regionalNotams`/`routeWaypoints` Props doc comment. Not
 *    duplicated here: passing those two props through to AerodromePopup is
 *    the whole job, mirrors native's "OTHER NOTAMS" block under its own
 *    NOTAM tab (also owned by the single shared AerodromeNotamSection now).
 */

import { useEffect, useState } from 'react'
import css from './VicinityBriefPanel.module.css'
import AerodromePopup from './AerodromePopup'
import type { VicinityAerodrome } from '../hooks/useVicinityAerodromes'
import { toNearbyFreqs, type NearbyAerodrome } from '../hooks/useNearbyFrequencies'
import type { RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { filterNotamsNearRoute } from '@open-vfr/shared/notamRouteFilter'
import type { RouteWaypoint } from '../utils/routeCalc'

const SVC_COLOR: Record<string, string> = {
  TWR: '#3b82f6', AFIS: '#3b82f6', APP: '#8b5cf6', DEP: '#8b5cf6',
  GND: '#10b981', SMC: '#10b981', ATIS: '#f59e0b', FIS: '#06b6d4',
  INFO: '#06b6d4', RDO: '#94a3b8', RADIO: '#94a3b8', UNICOM: '#94a3b8',
}
function svcColor(svc: string) { return SVC_COLOR[svc] ?? '#94a3b8' }

type Tab = 'freq' | 'wx' | 'notam'

interface Props {
  nearbyFreqs: NearbyAerodrome[]
  aerodromes:  VicinityAerodrome[]
  isHome:      (icao: string) => boolean
  authed:      boolean
  onSetHome:   (icao: string, name: string, lng: number, lat: number) => void
  onRunwayWind?: (icao: string, ends: RunwayWindEnd[]) => void
  // FIR-wide regional NOTAMs (unfiltered -- filtering to the planned route,
  // when one exists, happens in here) + the route itself, for the NOTAMs
  // tab. Both optional so this panel keeps working standalone (e.g. in a
  // context with no regional-NOTAM feed wired up) -- the tab just shows an
  // empty list rather than never rendering.
  regionalNotams?: NotamItem[]
  routeWaypoints?: RouteWaypoint[]
  onShowNotamOnMap?: (notam: NotamItem) => void
  onClose:     () => void
}

export default function VicinityBriefPanel({
  nearbyFreqs, aerodromes, isHome, authed, onSetHome, onRunwayWind,
  regionalNotams = [], routeWaypoints = [], onShowNotamOnMap,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>('freq')
  const [selectedIcao, setSelectedIcao] = useState<string | null>(null)

  useEffect(() => {
    if (aerodromes.length === 0) { setSelectedIcao(null); return }
    setSelectedIcao((prev) => (prev && aerodromes.some((a) => a.icao === prev)) ? prev : aerodromes[0].icao)
  }, [aerodromes])

  const selected = aerodromes.find((a) => a.icao === selectedIcao) ?? aerodromes[0] ?? null

  const hasRoute = routeWaypoints.length > 0
  const displayedRegionalNotams = hasRoute
    ? filterNotamsNearRoute(regionalNotams, routeWaypoints)
    : regionalNotams

  // GPS-only nearbyFreqs going empty doesn't necessarily mean "nothing
  // relevant" -- it means "no live GPS fix", which is routine while just
  // planning a route. Fall back to the same route/GPS/home-prioritized,
  // already along-route-sorted `aerodromes` list Weather/NOTAMs use, rather
  // than showing an empty tab whenever GPS is unavailable. Left untouched
  // (GPS list wins) whenever it actually has entries, matching native's
  // "Freq tab: unchanged" GPS-radius behaviour for the case that still
  // works.
  const displayedFreqs: NearbyAerodrome[] = nearbyFreqs.length > 0
    ? nearbyFreqs
    : aerodromes.map((a) => ({
        icao: a.icao, name: a.name, distNm: a.distNm,
        frequencies: toNearbyFreqs(a.props.frequencies ?? []),
      }))

  return (
    <div className={css.backdrop} onClick={onClose}>
      <div className={css.panel} onClick={(e) => e.stopPropagation()}>
        <div className={css.header}>
          <span className={css.title}>Airfield Brief</span>
          <button className={css.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={css.tabBar}>
          <button className={`${css.tab} ${tab === 'freq' ? css.tabActive : ''}`} onClick={() => setTab('freq')}>
            Frequencies{displayedFreqs.length > 0 ? ` (${displayedFreqs.length})` : ''}
          </button>
          <button className={`${css.tab} ${tab === 'wx' ? css.tabActive : ''}`} onClick={() => setTab('wx')}>
            Weather
          </button>
          <button className={`${css.tab} ${tab === 'notam' ? css.tabActive : ''}`} onClick={() => setTab('notam')}>
            NOTAMs{displayedRegionalNotams.length > 0 ? ` (${displayedRegionalNotams.length})` : ''}
          </button>
        </div>

        {tab === 'freq' && (
          <div className={css.freqList}>
            {displayedFreqs.length === 0 ? (
              <div className={css.empty}>No aerodromes with published frequencies nearby. Enable GPS, load a route, or set a home airfield in Settings.</div>
            ) : displayedFreqs.map((ad) => (
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

        {(tab === 'wx' || tab === 'notam') && (
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
              {tab === 'wx' && (
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
                    forcedTab="wx"
                  />
                </div>
              )}
              {tab === 'notam' && (
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
                    forcedTab="notam"
                    regionalNotams={regionalNotams}
                    routeWaypoints={routeWaypoints}
                    onShowNotamOnMap={onShowNotamOnMap}
                  />
                </div>
              )}
            </>
          )
        )}
      </div>
    </div>
  )
}
