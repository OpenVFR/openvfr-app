# OpenVFR

OpenVFR is a free, open-source Electronic Flight Bag (EFB) for VFR pilots —
real-time airspace awareness, terrain and obstacle profiles, and aviation
charts, built entirely on open data. No account required, no paywalls, no
lock-in.

Released under the [MIT License](./LICENSE).

## ⚠️ Situational awareness only

OpenVFR is **not certified by any civil aviation authority** (FAA, EASA, or
otherwise) and must not be used as a primary means of navigation or
airspace compliance. It is intended strictly for pre-flight planning and
secondary, in-flight situational awareness.

The **pilot in command (PIC)** holds sole responsibility for flight safety,
airspace compliance, and the use of approved primary navigation sources.
Always cross-check against official, certified charts and NOTAMs (e.g. AIP,
eAIP, or your national aviation authority's published sources).

## Repository layout

```
apps/
  web/       React PWA (Vite, TypeScript, CSS Modules) — the primary EFB UI
  native/    React Native (Expo) app — in-cockpit build, shares apps/web's
             aviation data format and most business logic via packages/shared
  api/       Hono API server — auth, POH-extraction proxy, weather/NOTAM
             privacy proxy, live traffic polling
packages/
  shared/    Code shared between apps/web and apps/native (calculations,
             colour palettes, fetch helpers, types)
db/
  migrations/  PostgreSQL + PostGIS schema (applied via dbmate)
docker/      Dockerfiles + nginx/Martin config for self-hosting
docs/        Architecture reference and self-hosting guide
```

Map/aviation data (basemap, airspace, aerodromes, navaids, obstacles,
landmarks, terrain) is **not included in this repository** — it's large,
regenerated on an AIRAC/refresh cadence, and produced by a separate data
pipeline. See [`docs/self-hosting.md`](docs/self-hosting.md) for how to
generate it yourself.

## Getting started

```sh
pnpm install
docker compose up -d db martin api postgrest   # backend services
pnpm dev                                        # web app on :5173
```

The map will render with an empty basemap/aviation layers until you've
generated tile data — see [`docs/self-hosting.md`](docs/self-hosting.md).

For native app development, see [`apps/native/README.md`](apps/native/README.md).

Full architecture reference: [`docs/architecture.md`](docs/architecture.md).

## Rollout

- **Web app** launches first — in **Sweden**, before expanding to the
  Nordics and other major European countries.
- **Android and iOS** apps follow shortly after the web app.

## Data & attribution

OpenVFR is built on the following data and map sources:

* **[aviationweather.gov](https://aviationweather.gov/)** (NOAA Aviation
  Weather Center) — METAR and TAF data. US government, public domain.
* **[FAA NOTAM Management Service (NMS-API)](https://www.faa.gov/air_traffic/publications/atpubs/notam_html/)** —
  worldwide NOTAM lookup. Requires credentials manually issued by the FAA's
  NOTAM Service Center (no self-service signup — email
  `7-AWA-NAIMES@faa.gov` or call 866-466-1336; see `docs/self-hosting.md`).
  NOTAMs are exchanged internationally via ICAO's global distribution
  system and FAA's system carries international series including European
  airspace — there is no free/public equivalent on the European side
  (Eurocontrol EAD requires a paid service agreement for real access). Do
  not treat as a complete substitute for official national NOTAM/AIP
  sources.
* **[OpenSky Network](https://opensky-network.org/)** — live ADS-B air
  traffic data, via a registered OpenSky account (rate/credit limited).
* **[OpenAIP](https://www.openaip.net/)** — airspace and obstacle data.
  Licensed **CC BY-NC 4.0 — non-commercial use only.** This restricts
  commercial use of the combined app; see § License note below.
* **[OpenFlightMaps](https://www.openflightmaps.org/)** — VFR chart
  layers. Licensed ODbL.
* **[Copernicus DEM GLO-30](https://registry.opendata.aws/copernicus-dem/)**
  (ESA / European Union) — 30 m digital elevation model used for the
  optional map hillshade (relief shading) and elevation contour line
  layers. Free & open license, commercial use permitted; attribution via
  DOI [10.5270/ESA-c5d3d65](https://doi.org/10.5270/ESA-c5d3d65).
* **[OpenStreetMap](https://www.openstreetmap.org/copyright)** (via
  Overpass API / Geofabrik extracts) — supplementary obstacles (masts,
  chimneys, water towers). Licensed ODbL.
* **[Protomaps](https://protomaps.com/)** (`@protomaps/basemaps`) —
  vector basemap tiles, fonts, and sprites. Licensed BSD-3-Clause.
* **ESRI** — satellite imagery basemap toggle. Proprietary / subject to
  ESRI's own terms of use — not open data; usage must comply with ESRI's
  licensing terms independently of this project's open-source status.

Each dataset carries its own license and attribution terms — see
individual source licenses before reuse.

> **License note:** OpenAIP's CC BY-NC 4.0 term applies to a component of
> this app's data, not its code. It restricts *commercial use of that
> data*, independent of the MIT-licensed source code. If OpenVFR or any
> fork is monetized, OpenAIP-derived layers may need to be replaced or
> licensed separately. This does not affect the code's MIT license, but
> does affect what a commercial deployment can legally display.

### Map icon sources (`apps/web/public/poi_icons/*.svg`)

Used by `apps/web/src/utils/{obstacle,landmark,navaid,aerodrome}Icons.ts` (web)
and `apps/native/scripts/gen-poi-icons.mjs` (native, rasterized to PNG via
`@resvg/resvg-js`). Colour recolouring applied at load time — source files
are plain black-fill SVGs.

| Registered ID | Source | Source repo | License |
|---|---|---|---|
| `obs-wind-turbine` | Temaki `wind_turbine.svg` | https://github.com/rapideditor/temaki | CC0 1.0 |
| `obs-tower` | Temaki `tower.svg` | https://github.com/rapideditor/temaki | CC0 1.0 |
| `obs-chimney`, `lmk-chimney` | Temaki `chimney.svg` | https://github.com/rapideditor/temaki | CC0 1.0 |
| `obs-building` | Maki `building.svg` | https://github.com/mapbox/maki | CC0 1.0 |
| `obs-other` | Maki `triangle-stroked.svg` | https://github.com/mapbox/maki | CC0 1.0 |
| `lmk-church` | Maki `place-of-worship.svg` | https://github.com/mapbox/maki | CC0 1.0 |
| `lmk-mast` | Temaki `mast.svg` | https://github.com/rapideditor/temaki | CC0 1.0 |
| `lmk-windmill` | Temaki `windmill.svg` | https://github.com/rapideditor/temaki | CC0 1.0 |
| `lmk-water-tower` | Temaki `water_tower.svg` | https://github.com/rapideditor/temaki | CC0 1.0 |
| `nav-vor`, `nav-ndb`, `wp-mrp`, `wp-rp`, `ad-airport`, `ad-heliport` | Hand-written (original) | — | N/A — not sourced externally |

Raw file listing (for finding more icons later):
- Temaki full icon list: https://github.com/rapideditor/temaki/tree/main/icons
- Temaki icon preview/search: https://rapideditor.github.io/temaki/
- Maki full icon list: https://github.com/mapbox/maki/tree/main/icons
- Maki icon preview/search: https://labs.mapbox.com/maki-icons/
- Both repos: raw SVG via `https://raw.githubusercontent.com/<org>/<repo>/main/icons/<name>.svg`

When adding new icons, verify the license file at the root of whichever repo
is used (`LICENSE` / `LICENSE.md`) before pulling — not all icon sets on
GitHub are CC0; some (e.g. Font Awesome Free) are CC BY 4.0 and require
attribution.

## Stay in the loop

- Website: [openvfr.org](https://openvfr.org)
- Join the waitlist / become an early adopter (especially in Sweden — beta
  testers wanted): [openvfr.org/#waitlist](https://openvfr.org/#waitlist)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) — changes affecting flight-critical
calculations (fuel burn, weight & balance, true airspeed, magnetic
variation, great-circle/geodesic math) require test coverage before merge.

## License

Released under the [MIT License](./LICENSE). See the disclaimer above —
the license's standard "AS IS" warranty disclaimer applies in full; this
software carries no certification or guarantee of accuracy for flight use.
