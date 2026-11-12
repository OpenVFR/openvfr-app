import { describe, it, expect } from 'vitest'
import { isTileGeojson } from '../pwa-rules'
import config from '../vite.config.ts?raw'

describe('isTileGeojson', () => {
  it('matches geojson from the production tile host (no /tiles/ segment)', () => {
    expect(isTileGeojson(new URL('https://tiles.openvfr.org/se-aerodromes.geojson?v=abc123'))).toBe(true)
    expect(isTileGeojson(new URL('https://tiles.openvfr.org/se-aerodrome-details.geojson'))).toBe(true)
  })
  it('matches geojson under a /tiles/ segment of a self-hosted base URL', () => {
    expect(isTileGeojson(new URL('https://cdn.example.org/aviation/tiles/se-aerodromes.geojson'))).toBe(true)
  })
  it('matches geojson from the same-origin /tiles/ path (dev, proxied)', () => {
    expect(isTileGeojson(new URL('https://app-staging.openvfr.org/tiles/se-airspace.geojson?v=1'))).toBe(true)
    expect(isTileGeojson(new URL('http://localhost:5174/tiles/se-aerodromes.geojson'))).toBe(true)
  })
  it('leaves everything else alone', () => {
    expect(isTileGeojson(new URL('https://tiles.openvfr.org/se-basemap.pmtiles'))).toBe(false)
    expect(isTileGeojson(new URL('https://tiles.openvfr.org/manifest.json'))).toBe(false)
    expect(isTileGeojson(new URL('https://api.openvfr.org/data.geojson'))).toBe(false)
    expect(isTileGeojson(new URL('https://app.openvfr.org/assets/country.geojson'))).toBe(false)
  })
})

describe('the service-worker rule in vite.config.ts', () => {
  // Workbox stringifies urlPattern functions into sw.js: they may not call helpers or use imports. Guard both.
  const block = config.slice(config.indexOf("cacheName: 'aviation-data'") - 900, config.indexOf("cacheName: 'aviation-data'"))
  const fn = /urlPattern: \(\{ url \}: \{ url: URL \}\) =>\s*([\s\S]*?),\n\s*handler/.exec(block)?.[1]

  it('is self-contained (no helper from the config file)', () => {
    expect(fn).toBeTruthy()
    expect(fn).not.toMatch(/isTileGeojson/)
    expect(config).not.toMatch(/from '\.\/pwa-rules'/)
  })
  it('behaves like isTileGeojson', () => {
    const rule = new Function('url', `return ${fn}`) as (u: URL) => boolean
    for (const u of ['https://tiles.openvfr.org/se-aerodromes.geojson?v=1', 'http://localhost:5174/tiles/se-airspace.geojson',
      'https://tiles.openvfr.org/se-basemap.pmtiles', 'https://api.openvfr.org/data.geojson', 'https://app.openvfr.org/assets/x.geojson']) {
      expect(rule(new URL(u))).toBe(isTileGeojson(new URL(u)))
    }
  })
})
