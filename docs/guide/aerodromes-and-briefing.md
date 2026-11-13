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

## Charts

Where an aerodrome has official charts published, its card has a **Charts**
section. The visual approach, aerodrome, parking and ground charts are
listed first; **More charts** shows the rest, including the instrument
ones that a VFR flight does not use.

- The **arrow** icon opens the official document at the publisher. It
  works for everyone, signed in or not.
- When you are signed in, tapping a chart's **title** shows the publisher's
  own document in the app, and the **pin** icon draws a georeferenced chart
  over the map (with an opacity control).
- Charts are the publisher's own, unaltered documents. They are shown for
  the aerodromes the operator has released. An aerodrome without a Charts
  section has none released yet, so open the official publication instead.
- **Always check the official publication.** A georeferenced overlay is
  approximate (a few hundred metres) and is not for navigation.
- A deployment can restrict in-app viewing to administrators. Then the
  section is not shown to other users.

Administrators who switch on **Include unreviewed** (Settings) also see the
charts of aerodromes that are not released yet, marked as not released.

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
