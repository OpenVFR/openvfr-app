/**
 * Map data credits shown by the map's info (i) button -- web's MapInfoBar
 * and native's AviationMap attribution dialog both render this list, so the
 * two platforms can't drift apart.
 *
 * Mirrors README.md's "Data & attribution" section -- keep in sync with it.
 * Only the sources actually rendered as visible map layers (weather/NOTAM/
 * traffic API sources are cited in the README but aren't map "credits").
 */
export interface AttributionSource {
  name: string
  note: string
  url: string
}

export const ATTRIBUTION_SOURCES: readonly AttributionSource[] = [
  { name: 'Protomaps', note: 'Vector basemap tiles, fonts, sprites (BSD-3-Clause)', url: 'https://protomaps.com/' },
  { name: 'OpenStreetMap', note: 'Basemap + landuse data (\u00a9 OpenStreetMap contributors, ODbL)', url: 'https://www.openstreetmap.org/copyright' },
  { name: 'OpenFlightMaps', note: 'VFR chart / airspace layers (ODbL)', url: 'https://www.openflightmaps.org/' },
  { name: 'OpenAIP', note: 'Airspace and obstacle data (CC BY-NC 4.0 \u2014 non-commercial use only)', url: 'https://www.openaip.net/' },
  { name: 'Copernicus DEM GLO-30', note: '\u00a9 ESA / European Union \u2014 hillshade & contour lines, doi:10.5270/ESA-c5d3d65', url: 'https://doi.org/10.5270/ESA-c5d3d65' },
  { name: 'ESRI', note: 'Satellite imagery basemap toggle (proprietary, ESRI terms apply)', url: 'https://www.esri.com/en-us/legal/terms/full-master-agreement' },
]
