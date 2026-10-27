---
title: Virtual Radar and vertical profile
description: How to read the vertical profile of your route, your flown track or your live position.
sidebar:
  order: 8
---

The vertical profile is a side view of your route. It shows the ground,
your planned levels, airspace, obstacles, the minimum safe altitude, wind
and weather along the way. On the web app it is called **Virtual Radar**;
on native it is the **vertical profile**. They show the same thing.

It works in three situations:

- **Planning:** the profile of your route.
- **Flying:** the same profile with your aircraft on it, and a short
  forecast of where you are heading.
- **Reviewing a flight log:** the flown track, drawn on the same chart. See
  [Flight logs](./flight-logs.md).

## Reading the chart

The horizontal axis is distance along the route. The vertical axis is
altitude above mean sea level, in feet.

- **Ground.** The terrain under the route, drawn as a filled area. Lakes
  and the sea are marked where the route crosses water (web).
- **Your level.** The planned altitude of each leg, as a line stepping
  between legs. The drawn line is what the aircraft can actually reach: it
  climbs from the departure and descends to the destination using the
  performance of the selected aircraft. See [Aircraft and fuel](./aircraft-and-fuel.md).
- **TOC and TOD.** Top of climb and top of descent. When a leg is too short
  to reach the level you asked for, the TOC shows the altitude reached and
  the level you set, for example `TOC 2,800 ft (3,500 ft set)`. A note on
  the chart tells you which legs do not reach their level.
- **Minimum safe altitude (MSA).** A line over the highest terrain and
  obstacles in a corridor along the route, plus a clearance. A planned
  level below it is drawn in red. Near the departure and destination
  (within 5 NM of an aerodrome) being low is normal, so the warning is
  suppressed there. The margins are set in Settings. See [MSA](#msa-and-margins).
- **Airspace.** Boxes and chips for each airspace the route crosses, with
  its name and limits, coloured by class. Floors and ceilings are as
  published; AGL limits are converted using the terrain.
- **Obstacles.** Masts, towers and similar, drawn at their position along
  the route and at their height. Those that limit your level are shown
  more strongly. A toggle shows height labels for the obstacles near your
  level.
- **Aerodromes and landmarks** along the route.
- **Weather.** Cloud layers from METAR stations along the route, drawn as
  cloud glyphs at their reported altitude. The label says which station
  and how far off the route it is.
- **Winds aloft.** Wind barbs at several levels, with direction and speed.

## Changing your level on the chart

Press a leg on the chart and drag up or down to change its level. The level
follows your finger and snaps to 100 ft. Dragging below the lowest step
clears the leg's own level, so it falls back to the route's default.

While you are flying, levels are locked. Tap a leg (on the chart or on the
map) to unlock it for a short time.

## Controls

- **Zoom** in and out along the route (Ctrl and mouse wheel on the web, or
  pinch). A long route does not shrink to fit: the chart scrolls
  horizontally instead.
- **MSA** on and off.
- **Obstacle labels** on and off.
- **Winds aloft** on and off.
- **Collapse** the chart to give the map more room, or resize it (web).

## Live view

In flying mode your aircraft is drawn on the chart at its altitude and
position along the route. The chart keeps your altitude in view, and a
forward trajectory shows ticks a few minutes or miles ahead (set the
interval in Settings: time or distance). If you wander more than 3 NM off
the route, the chart says so, because it is then showing a route you are no
longer on.

## MSA and margins

The MSA for a leg is the highest of:

- the highest terrain in a corridor around the leg, plus the **terrain
  clearance**;
- the highest obstacle in the corridor, plus the **obstacle clearance**.

Defaults: corridor half-width 5 NM, terrain clearance 800 ft, obstacle
clearance 1,000 ft. You can change all three in Settings (corridor 1 to 10
NM, clearances 300 to 2,000 ft). Both the chart, the pre-flight check and
the automatic cruise level for new legs use the same numbers.

## How accurate is it?

Airspace limits are published as flight levels or heights above a
pressure reference, but the chart compares them against GPS altitude
(corrected to mean sea level). That is a good approximation, not exact:
the difference can be a few hundred feet in unusual temperatures or
pressures. Use the chart for awareness, never to prove you stayed clear of
airspace. Set your altimeter and follow the published limits.

## Web and native

The content is the same. On the web the chart is resizable and has the
lake overlay. On native the lake overlay is left out to save memory, and
gestures are touch-first. See [Web app and native app](./platforms.md).
