import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Vite only exposes .env.local as import.meta.env (client-side) — it does NOT
// populate process.env for this config file itself. Without loadEnv() here,
// every `process.env['VITE_DEV_API_TARGET']` below silently evaluates to
// undefined and each proxy falls back to its localhost:5200/5300 default,
// even with VITE_DEV_API_TARGET correctly set in .env.local.
const env = loadEnv('development', process.cwd(), '')
const DEV_API_TARGET = env['VITE_DEV_API_TARGET']
// /tiles and /api/traffic have no localhost fallback, unlike the other
// /api/* proxies below: there's no local tile mirror or traffic poller to
// fall back to by default. Set these in .env.local to a running instance
// (yours, or one you have access to) to exercise these two locally; see
// docs/self-hosting.md. Left unset, these two proxy entries aren't
// registered at all (dev server 404s /tiles/* unless public/tiles/ is
// populated locally, per dev.sh).
// Dev-only sign-in against a REMOTE API (VITE_DEV_API_TARGET set to a hosted
// instance). better-auth rejects any Origin header that is not in that
// server's trusted list ("Invalid origin"), and a hosted instance rightly
// trusts only its own app origin, not http://localhost:<port>. Setting
// VITE_DEV_API_ORIGIN to that app origin makes the dev server's proxy present
// it on requests it forwards to the remote API, and strip the cookie Domain
// so the session cookie sticks on localhost. Nothing changes server-side, so
// production's trusted-origin list stays as strict as before; this exists
// only inside `vite` (dev server) and is not part of any build output. Unset
// (the default) = proxy forwards the browser's real Origin untouched.
const DEV_API_ORIGIN = DEV_API_TARGET ? (env['VITE_DEV_API_ORIGIN'] || '') : ''
const devApiOrigin = DEV_API_ORIGIN
  ? {
      cookieDomainRewrite: { '*': '' },
      configure: (proxy: { on: (ev: 'proxyReq', cb: (req: { setHeader: (k: string, v: string) => void; getHeader: (k: string) => unknown }) => void) => void }) => {
        proxy.on('proxyReq', (proxyReq) => {
          if (proxyReq.getHeader('origin')) proxyReq.setHeader('origin', DEV_API_ORIGIN)
          if (proxyReq.getHeader('referer')) proxyReq.setHeader('referer', `${DEV_API_ORIGIN}/`)
        })
      },
    }
  : {}
const DEV_TILES_TARGET   = env['VITE_DEV_TILES_TARGET']   || ''
const DEV_TRAFFIC_TARGET = env['VITE_DEV_TRAFFIC_TARGET'] || DEV_API_TARGET || ''

export default defineConfig({
  plugins: [
    // Hard stop: VITE_DEV_API_ORIGIN is a dev-server-only sign-in workaround
    // (see DEV_API_ORIGIN above). It has no meaning in a build, so a build that
    // sees it set -- e.g. a .env.local copied onto a CI/release machine --
    // fails instead of shipping with a dev override configured.
    {
      name: 'openvfr:forbid-dev-api-origin-in-build',
      config(_cfg: unknown, { command }: { command: string }) {
        if (command === 'build' && env['VITE_DEV_API_ORIGIN']) {
          throw new Error('VITE_DEV_API_ORIGIN is set. It is a dev-server-only sign-in override and must not be present for `vite build`. Remove it from the environment / .env.local and rebuild.')
        }
      },
    },
    react(),
    VitePWA({
      registerType: 'prompt',
      // Disable the service worker in dev mode — it can intercept Range requests
      // for large binary assets (PMTiles) and return cached error responses that
      // cause "Wrong magic number" errors on subsequent loads.
      devOptions: { enabled: false },
      workbox: {
        // Don't precache .pmtiles archives — they are large and fetched on demand
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        globIgnores: ['**/*.pmtiles', '**/*.mbtiles'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            // Navigation requests (HTML page loads) use NetworkFirst so the
            // browser always receives fresh response headers (e.g. CSP) when
            // online. Falls back to the precache when offline so the app still
            // works without a connection.
            urlPattern: ({ request }: { request: Request }) => request.mode === 'navigate',
            handler: 'NetworkFirst' as const,
            options: {
              cacheName: 'navigations',
              networkTimeoutSeconds: 3,
            },
          },
          {
            // GeoJSON aviation data files — StaleWhileRevalidate so the map
            // renders immediately from cache on repeat visits and offline, while
            // the updated file is fetched in the background for the next load.
            // 35-day expiry covers a full AIRAC cycle with one day of margin.
            urlPattern: /\/tiles\/.*\.geojson(\?.*)?$/,
            handler: 'StaleWhileRevalidate' as const,
            options: {
              cacheName: 'aviation-data',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 35 },
            },
          },
          {
            // Elevation proxy (route terrain profiles + live ground elevation).
            // Terrain does not change, so CacheFirst: a route flown before keeps
            // its terrain line, MSA and AGL airspace lift offline. Keyed by the
            // full URL, so the same waypoints hit the same entry.
            urlPattern: /\/api\/elevation\/.*/,
            handler: 'CacheFirst' as const,
            options: {
              cacheName: 'elevation-cache',
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // METAR / TAF proxy — serve stale for up to 10 minutes so popups
            // open instantly offline, then refresh in background when back online.
            urlPattern: /\/api\/weather(\?.*)?$/,
            handler: 'StaleWhileRevalidate' as const,
            options: {
              cacheName: 'wx-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 10 },
            },
          },
          {
            // NOTAM proxy — serve stale for up to 30 minutes offline.
            urlPattern: /\/api\/notam(\?.*)?$/,
            handler: 'StaleWhileRevalidate' as const,
            options: {
              cacheName: 'notam-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 30 },
            },
          },
        ],
      },
      manifest: {
        name: 'OpenVFR',
        short_name: 'OpenVFR',
        description: 'Open source European VFR Electronic Flight Bag',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'fullscreen',
        orientation: 'any',
        icons: [
          { src: 'pwa-64x64.png',            sizes: '64x64',   type: 'image/png' },
          { src: 'pwa-192x192.png',           sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png',           sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],

  build: {
    // Note: Rolldown (Vite 8) handles code splitting automatically.
    // The object form of manualChunks was removed in Vite 8.
    chunkSizeWarningLimit: 1200, // MapLibre is intentionally large
    // copyPublicDir stays at its default (true) so small icon assets
    // (aircraft_icons/, poi_icons/) are present in dist/ at the point
    // vite-plugin-pwa scans it for its precache manifest -- same as
    // before. public/tiles/* is stripped from dist/ in a separate step
    // AFTER this build finishes (scripts/remove-tiles-from-dist.mjs),
    // which is safe because *.pmtiles/*.mbtiles are already excluded from
    // the precache manifest via the PWA plugin's globIgnores below, so
    // removing them afterward doesn't affect what the service worker
    // already committed to precaching.
  },

  // Pre-bundle heavy dependencies so the browser doesn't need to transform
  // them on every cold start. Add any new large imports here.
  optimizeDeps: {
    include: [
      'maplibre-gl',
      'pmtiles',
      '@protomaps/basemaps',
      'recharts',
      'rxdb',
      'rxdb/plugins/storage-dexie',
      'rxdb/plugins/dev-mode',
      'dexie',
      '@turf/along',
      '@turf/boolean-intersects',
      '@turf/helpers',
      '@turf/length',
      '@turf/line-intersect',
      '@turf/nearest-point-on-line',
    ],
  },

  server: {
    host: true,      // Listen on 0.0.0.0 — handy for LAN testing
    port: 5174,
    strictPort: true,
    // usePolling must NOT be set when running on the host — it disables
    // native FS events (ReadDirectoryChangesW on Windows) and makes HMR
    // poll every file every 100 ms. Only enable inside Docker bind mounts.
    proxy: {
      // Proxy tile requests to a real tile host instead of requiring a full
      // local public/tiles/ mirror. Local public/tiles/ commonly lags behind
      // the real pipeline output (missing files like se-aeroways.geojson,
      // se-water.geojson, or a stale se-landuse.geojson instead of the
      // current tiled se-landuse.pmtiles, plus multi-hundred-MB files like
      // se-hillshade.pmtiles/se-contours.pmtiles nobody wants to keep synced
      // locally). Same rationale as '/api/traffic' below -- there's no
      // separate 'dev' tile dataset, it's the same AIRAC-cadence static data
      // regardless of which frontend build fetches it. TILES_BASE_URL still
      // defaults to '/tiles' (src/utils/env.ts) so this proxy is transparent
      // to app code -- no VITE_TILES_BASE_URL override needed for local dev.
      // Only registered when VITE_DEV_TILES_TARGET is set (see above).
      ...(DEV_TILES_TARGET ? { '/tiles': {
        target: DEV_TILES_TARGET,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/tiles/, ''),
        // Strip If-Range before forwarding. Every tile URL here is content-
        // hashed (?v=<sha256 prefix>, see tileManifest.ts) -- a URL never
        // points at changed content, so conditional Range revalidation is
        // unnecessary. More importantly, Node's http-proxy appears to mangle
        // the If-Range header value in transit (confirmed: identical
        // If-Range request against the tile host directly correctly returns
        // 206, but through this proxy returns a full 200 with the whole
        // file's Content-Length) -- pmtiles.js then throws "Server
        // returned no content-length header or content-length exceeding
        // request" because the response body is way bigger than the
        // requested range. The browser's own HTTP cache auto-adds If-Range
        // on repeat range requests to an already-cached immutable URL, so
        // this reliably reproduces in normal use, not just synthetic curl
        // tests. Stripping the header sidesteps the proxy bug entirely and
        // is always safe given the immutable/hashed URL model above.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('if-range')
          })
        },
      } } : {}),
      '/api/elevation': {
        target: 'https://api.opentopodata.org',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/elevation/, '/v1'),
      },
      '/api/open-meteo': {
        target: 'https://api.open-meteo.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/open-meteo/, '/v1'),
      },
      '/api/poh-extract': {
        target: 'http://localhost:5200',
        changeOrigin: true,
      },
      // Only registered when a traffic target is configured (see
      // DEV_TRAFFIC_TARGET above) -- unlike the other /api/* proxies, there's
      // no localhost fallback: the OpenSky traffic poller runs against a
      // single account with a tight daily credit quota (server/src/traffic.ts)
      // -- a second independent poller from local dev would silently
      // double-burn that quota using the SAME OpenSky credentials, since both
      // would share the same .env values. Point this at an already-running
      // instance's poller instead of starting a second one.
      ...(DEV_TRAFFIC_TARGET ? { '/api/traffic': {
        target: DEV_TRAFFIC_TARGET,
        changeOrigin: true,
      } } : {}),
      '/api/weather': {
        ...devApiOrigin,
        // Overridable via VITE_DEV_API_TARGET so local dev can point at a
        // running API instance instead of requiring the full docker-compose
        // stack (db/martin/api/postgrest) just to verify a frontend-only
        // change -- same reasoning as '/api/traffic' above, opt-in via env
        // rather than changing the default for everyone else.
        target: DEV_API_TARGET || 'http://localhost:5200',
        changeOrigin: true,
      },
      '/api/notam': {
        ...devApiOrigin,
        target: DEV_API_TARGET || 'http://localhost:5200',
        changeOrigin: true,
      },
      '/api/auth': {
        ...devApiOrigin,
        target: DEV_API_TARGET || 'http://localhost:5200',
        changeOrigin: true,
      },
      '/rest': {
        ...devApiOrigin,
        // Overridable via VITE_DEV_API_TARGET, same as '/api/auth' below — the
        // PostgREST JWT is signed with whichever auth server issued it, so
        // it must be sent to that SAME origin's PostgREST (shared JWT secret)
        // or every request 401s with a valid-looking but wrong-audience token.
        target: DEV_API_TARGET || 'http://localhost:5300',
        changeOrigin: true,
        // Rewrite /rest/table → /table only for the LOCAL PostgREST fallback,
        // which is root-mounted (no nginx in front). When targeting prod
        // (DEV_API_TARGET set), prod's own nginx already strips /rest before
        // forwarding to its PostgREST — also root-mounted there. Stripping it
        // again here double-strips the path down to just /user_routes, which
        // prod's nginx doesn't recognize and falls through to the Hono app's
        // 404 catch-all instead of PostgREST.
        rewrite: DEV_API_TARGET ? undefined : (path: string) => path.replace(/^\/rest/, ''),
      },
    },
  },
})
