---
title: Aerodromes and briefing
description: Aerodrome information, finding a destination, direct to, the nearby brief and your home airfield.
sidebar:
  order: 9
---

## The aerodrome card

Tap an aerodrome on the map. The card has three tabs.

**Info**
- Sunrise and sunset (UTC). Check them against your landing time.
- Frequencies.
- Runways: designators, length, width and surface.
- Hours of operation, and whether the tower is open now, worked out from
  the published schedule. A hint appears if an active NOTAM might affect
  ATC or opening hours: check the NOTAM tab. The hint comes from keywords
  in the text and is never a definitive status.
- Facilities (fuel and so on), **PPR and restrictions**, and contact
  details.
- A button to make it your **home airfield**.

**Weather (Wx)**
- Choose a source: **METAR** (the aerodrome's own report, falling back to
  the nearest station that has one) or **Weather station** (a model-based
  current reading at the aerodrome's position). Both are always fetched and
  they are never blended: you pick which one to read.
- Decoded METAR values coloured by flight category (see
  [Weather and NOTAMs](./weather-and-notams.md)), the TAF as an
  hour-by-hour timeline, a cloud profile, and wind gauges: a compass with a
  runway drawn across it, and a speed dial.
- Pick a runway to see the headwind and crosswind components. The longest
  runway is shown by default.

**NOTAM**
- NOTAMs for the aerodrome, then the wider regional list (areas, navaid
  outages and notices that are not tied to one aerodrome).
- See [Weather and NOTAMs](./weather-and-notams.md).

## Find a destination

Open **Find dest.** (also available from the route menu) to search
aerodromes by:

- name or ICAO code,
- fuel type: any, AVGAS or JET A1,
- surface: any, hard (asphalt and concrete) or grass (grass and sand),
- minimum runway length.

Results are sorted by distance from your position, or from the map centre
when there is no GPS fix, with the bearing and distance shown. Tap a row to
see it on the map, or press **+** to add it to the route.

## Direct to

While flying, **Direct to** replaces the route with a two-point route from
your position to the aerodrome you choose.

- Your **home airfield** is always listed first.
- If the aircraft has glide data, aerodromes within glide range are
  highlighted in green.
- You can filter by name or ICAO code and minimum runway length.

Direct to **replaces** your route. Undo restores it.

## Nearby brief

**Brief** gives one panel with three tabs for the aerodromes around you
(or the map centre):

- **Frequencies** nearby. If there is no GPS fix, it falls back to the
  aerodromes near your route.
- **Weather** and **NOTAMs** for a picker of nearby aerodromes. Aerodromes
  along your route come first, then those around your position, then your
  home airfield.

Use it in the air to get the frequency and weather of the field ahead
without hunting on the map.

## Home airfield

Set a home airfield from its card. It is used first in Direct to, as a
fallback for briefings, and has a quick button in the map tools. It syncs
with your account. See [Account and sync](./account-and-sync.md).
