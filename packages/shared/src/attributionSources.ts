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
  { name: 'OpenSky Network', note: 'Live air traffic (ADS-B)', url: 'https://opensky-network.org/' },
  { name: 'Open Glider Network', note: 'Live glider / FLARM traffic (ODbL)', url: 'https://www.glidernet.org/' },
  { name: 'FAA NOTAM Management Service', note: 'NOTAMs and NOTAM areas', url: 'https://www.faa.gov/air_traffic/publications/atpubs/notam_html/' },
  { name: 'aviationweather.gov (NOAA)', note: 'METAR and TAF', url: 'https://aviationweather.gov/' },
  { name: 'OpenTopoData \u00b7 EU-DEM v1.1', note: 'Terrain along the route (vertical profile, MSA, ground elevation). EU-DEM: Copernicus Land Monitoring Service, produced with funding by the European Union', url: 'https://www.opentopodata.org/datasets/eudem/' },
  { name: 'Open-Meteo', note: 'Weather data by Open-Meteo.com \u2014 model wind on the map, winds aloft, forecast wind (CC BY 4.0)', url: 'https://open-meteo.com/' },
]
