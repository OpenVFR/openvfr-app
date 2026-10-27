---
title: How it all fits together
description: The big picture of OpenVFR, from data to map, route, profile, alerts and logs.
sidebar:
  order: 11
---

OpenVFR is built around one idea: your route, your aircraft and your
position are compared against the same open data everywhere, so the map,
the vertical profile, the alerts and the flight log never disagree.

## The pieces

1. **Data.** Airspace, aerodromes, navaids, obstacles, terrain and basemap
   come from open sources and are refreshed on the aeronautical (AIRAC)
   cycle. Weather, wind and NOTAMs are fetched live. See
   [Data sources](./data-sources.md).
2. **Map.** Draws the data in layers you can switch on and off. See
   [Map and layers](./map-and-layers.md).
3. **Route and aircraft.** Your route legs plus the aircraft you pick give
   headings, wind correction, time and fuel. Wind for every leg comes from
   one place, so time, fuel and the pre-flight check agree. See
   [Planning a route](./planning-a-route.md).
4. **Vertical profile.** Slices terrain, obstacles, airspace and clouds
   along the route (or along your flown track in a log).
5. **Flying mode.** Takes your position from GPS (or a simulator) and feeds
   the alerts, auto zoom and the flight log. See
   [Flying mode and alerts](./flying-and-alerts.md).
6. **Flight logs.** Recorded during flying mode, reviewed on the same
   profile. See [Flight logs](./flight-logs.md).
7. **Account and sync.** Optional. Keeps routes, aircraft, places, logs and
   settings the same across your devices. See
   [Getting started](./getting-started.md).

## Ideas that apply everywhere

- **Airspace limits are heights in their own reference.** A limit in AGL
  is a height above the ground, not an altitude. OpenVFR converts before
  comparing with your altitude.
- **Alerts are deliberately quiet.** Debounce, merged cards and levels per
  airspace category keep the stack readable. See
  [Flying mode and alerts](./flying-and-alerts.md).
- **Offline first.** Anything you have loaded keeps working without
  signal. Live data (weather, NOTAMs, traffic, forecast wind) needs a
  connection and shows its age.
- **Same rules on every platform.** Calculations are shared between the
  web and native apps. The differences are in sensors and device features:
  see [Web app and native app](./platforms.md).
