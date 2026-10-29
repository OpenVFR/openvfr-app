---
title: Web app and native app
description: Which features are on the web app, Android and iOS, and where they differ.
sidebar:
  order: 18
---

OpenVFR comes as a web app (PWA) and as an Android and iOS app. They share
the same data, the same calculations (wind, fuel, terrain, alerts) and the
same account, so a route planned on one shows up on the other. They differ
in how they reach sensors, how they store data offline, and in a few
screens.

Legend: **Yes** = available, **Partial** = available with differences
(see the note), **No** = not available.

> **Maintainers:** this table is the single place to record parity. A change
> that adds, removes or alters a feature on one platform updates its row in
> the same PR. The table was checked against the code, not yet on devices.

## Map and data

| Feature | Web | Native | Note |
|---|---|---|---|
| Airspace, aerodromes, runways, navaids, waypoints, obstacles, landmarks | Yes | Yes | Same layer groups. |
| Terrain: land use, hillshade, contour lines | Yes | Yes | |
| Terrain colour bands (relative to a reference altitude) | Yes | Yes | Marked experimental on native. |
| Wind arrows | Yes | Yes | |
| Air traffic (ADS-B and glider/FLARM sources) | Yes | Yes | |
| Traffic vertical filter (hide traffic far above/below you) | Yes | No | Web setting only. |
| Altitude ceiling slider for airspace | Yes | Yes | |
| Satellite basemap | Yes | Yes | Not available while flying. |
| Themes: dark, light, high contrast | Yes | Yes | |
| UI scale | No | Yes | Native setting. |
| Country / region selection | Yes | Yes | Web: region selector. Native: Country section in Settings. |
| Offline use | Partial | Partial | Web caches in the browser. Native has an Offline data section in Settings. See below. |
| Share link to an aerodrome or position | Yes | Yes | |

## Planning

| Feature | Web | Native | Note |
|---|---|---|---|
| Build a route by tapping the map, with snapping | Yes | Yes | |
| Type a whole route as text (for example `ESOS ESGG ESSA`) | Yes | No | On native, add points by tapping, searching or Find destination. |
| Undo / redo route changes | Yes | Yes | Web also has [keyboard shortcuts](./keyboard-shortcuts.md). |
| Per-leg heading, wind correction, time | Yes | Yes | |
| Forecast wind per leg, manual wind override | Yes | Yes | |
| Fuel plan for a chosen aircraft | Yes | Yes | |
| Pre-flight warnings (airspace, below MSA, fuel) | Yes | Partial | Web has a dedicated warnings panel with all three checks. Native marks a leg below its MSA in red and warns when fuel required exceeds the tank, but has no airspace check in the plan. |
| Alternate destination | Yes | Yes | |
| Aircraft profiles | Yes | Yes | |
| Saved routes, routes sync | Yes | Yes | |
| Saved places (user waypoints) and folders | Yes | Yes | |
| Find destination by fuel, surface and runway length | Yes | Yes | |
| Ruler (distance and bearing) | Yes | Yes | |
| "What's here" popup on a map point | Yes | No | Native shows its own popover with Save / Direct / Route actions. |
| Weather and winds along the route | Yes | Yes | |
| Vertical profile (terrain, airspace, cloud) | Yes | Yes | Web: Virtual Radar, resizable. Native: vertical profile. |
| Export route as GPX, import GPX | Yes | Yes | Web downloads a file; native opens the share sheet. |
| Export route as KML | Yes | No | |
| Reverse route | Yes | Yes | |

## Weather and NOTAMs

| Feature | Web | Native | Note |
|---|---|---|---|
| METAR and TAF, TAF timeline | Yes | Yes | |
| Aerodrome brief: frequencies, weather, NOTAMs | Yes | Yes | |
| Brief for aerodromes near you or the map centre | Yes | Yes | |
| Regional NOTAMs on the map | Yes | Yes | |
| Cloud profile | Yes | Yes | |
| Wind gauges | Yes | Yes | |

## Flying

| Feature | Web | Native | Note |
|---|---|---|---|
| Flying mode with GPS | Yes | Yes | |
| Keeps tracking with the screen off or the app in the background | No | Yes | Native uses a background location service with a persistent notification. A browser tab can be suspended. |
| Auto start and stop from takeoff and landing | Yes | Yes | |
| Direct to | Yes | Yes | |
| Auto zoom while flying | Yes | Yes | |
| Alert stack: airspace, obstacles, aerodrome nearby | Yes | Yes | Same rules and settings. |
| Recent-alerts list | Yes | Yes | |
| Drop a point at your position | Yes | Yes | Saved in the "Dropped in Flight" folder. |
| Pilot log (live) | Yes | Yes | |
| Flight logs: list, review on profile, GPX export and import | Yes | Yes | |
| Flight logs sync between devices | Yes | Yes | |
| Instrument readouts and gauges bar | No | Yes | Native only. |
| Internal barometer (phone pressure sensor) | No | Yes | Used for altitude on devices that have one. |
| External vario (BlueFly) and phone vario | No | Yes | |
| QNH from nearby stations, field QNH, baro prompt | No | Yes | Altitude reference handling is native only. |
| Simulator: keyboard or touch | Yes | Yes | Web: keyboard simulator. Native: touch simulator. |
| Simulator: X-Plane / MSFS | Partial | Yes | Web needs a WebSocket bridge. Native connects over UDP or WebSocket directly. |
| GDL90 receivers (portable ADS-B receivers) | No | No | Not supported yet. |

## Account

| Feature | Web | Native | Note |
|---|---|---|---|
| Passkey sign-in | Yes | Yes | |
| Email one-time code sign-in | Yes | Yes | |
| Local data kept on the device | Yes | Yes | Routes, aircraft and settings are stored locally and synced. |
| Sync of routes, aircraft, places, logs, settings | Yes | Yes | |

## Where the platforms differ in how they work

- **Location in the background.** A web page can only track you while it
  is open and allowed to run. The native app keeps a background service
  running in flying mode.
- **Storage and offline.** The web app keeps data in the browser and caches
  the app itself, so it also starts offline once installed. The native app
  stores data on the device and manages downloaded map data under
  Settings → Offline data.
- **Sensors.** Phone barometer, vario hardware and receiver inputs are
  native only.
- **Files.** The web app downloads files (GPX). Native opens the system
  share sheet.
- **Updates.** The web app updates itself when you reload. Native updates
  come through the app store.

See [Flying mode and alerts](./flying-and-alerts.md),
[Planning a route](./planning-a-route.md) and
[Simulators and devices](./simulators-and-devices.md) for how the features
work, and the [feature index](./features.md) for the full list.
