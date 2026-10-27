---
title: Planning a route
description: Build a route, see heading, wind correction, time and fuel, and check it against terrain.
sidebar:
  order: 4
---

## Building the route

Tap or click the map to add waypoints. A tap within 20 px of a feature
snaps to it; if several features are close, a picker lists them with
aerodromes first. Drag a waypoint to move it. Dropping a waypoint onto the
point before or after it removes it.

## What each leg shows

Each leg shows magnetic heading and wind correction angle (for example
`093°M / WCA +3°`), the heading you actually fly rather than the track.

## Wind

Wind per leg comes from, in priority order:

1. A wind you typed for that leg.
2. A wind you typed for the whole route.
3. The forecast wind at the middle of the leg, at the leg's altitude and
   expected time. The forecast covers roughly the next 16 days. Outside
   that, or offline, still air is assumed.

Time and fuel use the same wind values, so they agree with each other.

## Cruise level

When you add a leg lower than the terrain under it plus 1,000 ft (or the
highest obstacle in its corridor plus 500 ft), its altitude is raised to
clear that and you are told. Legs you set yourself are not changed, but
the pre-flight check still flags them.

## Aircraft, fuel and profile

Choose or create an aircraft to get time and fuel. The vertical profile
shows terrain, obstacles and airspace along the route.
