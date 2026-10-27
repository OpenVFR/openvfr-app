---
title: Offline use and data updates
description: How OpenVFR works without a connection, how data is kept up to date, and how to choose a country.
sidebar:
  order: 15
---

## What needs a connection

| Works offline | Needs a connection |
|---|---|
| The app itself (once installed or downloaded) | Weather (METAR, TAF, model wind), NOTAMs, air traffic |
| The map and aviation data you have already loaded | Forecast wind for a route (offline: still air) |
| Planning, routes, aircraft, places, flight logs on the device | Sync between devices |
| Terrain along the route, when the terrain data is on the device | Signing in |

Anything you have loaded stays usable; live data shows its age. Short
connection gaps are tolerated: requests are retried, and the last good
value is kept instead of a blank.

## Country

Map data is per country. In Settings choose the **country**; one is active
at a time. The map and all datasets switch to it.

## Aviation data (AIRAC)

Aeronautical data (airspace, aerodromes, navaids, obstacles) is refreshed
on the AIRAC cycle. Settings shows the data version, the period it is
valid for, when it was last updated, and the next AIRAC date. If the data
is out of date, a warning says so.

- **Web:** when the data changes on the server, a small prompt offers to
  reload. A *Data versions* row in Settings lets you check for an update.
  A separate prompt appears when a new version of the app itself is ready.
- **Check before every flight** that the data is current. Out-of-date data
  can show airspace that has changed.

## Offline data on native

Under **Settings → Offline data** you download the map and aviation data
for the active country so the app works without a connection.

- Required aviation data is always included.
- Optional layers (basemap, land use, terrain, minimum-altitude grid,
  water) are ticked by default; contour lines are an extra you opt in to.
  Each shows its size, and what you lose if you skip it.
- A large-download warning appears first. The full set is several hundred
  megabytes, so use Wi-Fi.
- The list shows what is downloaded, its size, and whether it is outdated.
  Tap **Update offline data** after reconnecting to refresh outdated items.
- Offline terrain needs the terrain data; without it, terrain along the
  route and the height above ground fall back to the online service.
- One country is stored at a time.

## Repair

On the web app, **Settings → App files → Repair and reload** clears the
cached app and map data and re-downloads it. Your routes, aircraft, places,
logs and settings are kept. Use it if the app starts oddly or the map is
broken. It needs a connection and is not available in flight.
