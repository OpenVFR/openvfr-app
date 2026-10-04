// src/utils/env.ts
//
// Base URLs supporting an optional split-subdomain production topology
// (see docs/self-hosting.md): the frontend, API, and bulk static tiles can
// be deployed as three separate origins in production, or all on one
// origin — both are supported.

// API_BASE_URL defaults to '' (relative paths) so local dev is completely
// unchanged — dev already proxies /api/* and /rest to local services (see
// vite.config.ts's `server.proxy`), so a relative fetch continues to work
// exactly as before. Set VITE_API_BASE_URL as a production build env var to
// override this to an absolute API origin if you deploy it separately.
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

// TILES_BASE_URL defaults to '/tiles' — dev serves public/tiles/* at that
// path via Vite's static `public/` handling, matching today's behavior.
// Set VITE_TILES_BASE_URL to an absolute object-storage/CDN origin (bucket
// root, no /tiles/ prefix — see docs/self-hosting.md) in production if you
// serve bulk tile data separately from the app itself.
export const TILES_BASE_URL: string = (import.meta.env.VITE_TILES_BASE_URL as string | undefined) ?? '/tiles'

// SITE_BASE_URL — optional public site origin serving /privacy and /terms,
// linked from the sign-in panel footer. Empty (default) hides those links.
export const SITE_BASE_URL: string =
  ((import.meta.env.VITE_SITE_BASE_URL as string | undefined) ?? '').replace(/\/+$/, '')
