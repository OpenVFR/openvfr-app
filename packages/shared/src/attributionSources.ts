/**
 * Map data credits shown by the map's info (i) button -- web's MapInfoBar
 * and native's AviationMap attribution dialog both render this list, so the
 * two platforms can't drift apart.
 *
 * Mirrors README.md's "Data & attribution" section -- keep in sync with it.
 * Every source whose data is shown in the app: base layers, aviation
 * layers, the live overlays (model wind arrows, traffic, NOTAM areas,
 * METAR/TAF-based aerodrome colouring) and the vertical profile's terrain
 * (OpenTopoData / EU-DEM). Open-Meteo (CC BY 4.0), OGN (ODbL) and EU-DEM
 * (Copernicus: name the source, acknowledge EU funding) require the credit.
 */
/**
 * Notice the Copernicus DEM licence requires for ADAPTED GLO-30 data (our
 * hillshade, contours and offline terrain DEM are smoothed, extended and
 * re-encoded): copied verbatim from the Copernicus Data Space "User
 * Obligations" for COP-DEM. Use it wherever that data is credited (map source
 * attributions, credits list, README).
 */
export const COPERNICUS_GLO30_NOTICE =
  'produced using Copernicus WorldDEM-30 \u00a9 DLR e.V. 2010-2014 and \u00a9 Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved'

/**
 * Last row of the credits dialog (web + native): the website's full credits
 * page, with every source's licence and required notice.
 */
export const FULL_CREDITS_LINK: AttributionSource = {
  name: 'Full credits & licences',
  note: 'All data sources, their licences and required notices \u2014 openvfr.org/credits',
  url: 'https://openvfr.org/credits',
}

/**
 * Settings -> About (web + native): the open-source packages in the apps with
 * their licences. Rendered by the site from THIRD-PARTY-NOTICES.md.
 */
export const OPEN_SOURCE_LICENCES_LINK = {
  name: 'Open-source licences',
  url: 'https://openvfr.org/licences',
} as const

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
  { name: 'Copernicus DEM GLO-30', note: `Hillshade, contour lines, offline terrain \u2014 ${COPERNICUS_GLO30_NOTICE}`, url: 'https://doi.org/10.5270/ESA-c5d3d65' },
  { name: 'ESRI', note: 'Satellite imagery basemap toggle (proprietary, ESRI terms apply)', url: 'https://www.esri.com/en-us/legal/terms/full-master-agreement' },
  { name: 'OpenSky Network', note: 'Live air traffic (ADS-B)', url: 'https://opensky-network.org/' },
  { name: 'Open Glider Network', note: 'Live glider / FLARM traffic (ODbL)', url: 'https://www.glidernet.org/' },
  { name: 'FAA NOTAM Management Service', note: 'NOTAMs and NOTAM areas', url: 'https://www.faa.gov/air_traffic/publications/atpubs/notam_html/' },
  { name: 'aviationweather.gov (NOAA)', note: 'METAR and TAF', url: 'https://aviationweather.gov/' },
  { name: 'OpenTopoData \u00b7 EU-DEM v1.1', note: 'Terrain along the route (vertical profile, MSA, ground elevation). EU-DEM: Copernicus Land Monitoring Service, produced with funding by the European Union', url: 'https://www.opentopodata.org/datasets/eudem/' },
  { name: 'Open-Meteo', note: 'Weather data by Open-Meteo.com \u2014 model wind on the map, winds aloft, forecast wind (CC BY 4.0)', url: 'https://open-meteo.com/' },
]
