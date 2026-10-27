---
title: Planning a route
description: Build a route, edit legs, and see heading, wind correction, time and fuel.
sidebar:
  order: 5
---

## Building the route

Add waypoints by tapping or clicking the map, by searching, or by typing
the whole route as text (for example `ESOS ESGG ESSA`). Other ways:

- **From a card:** add an aerodrome, navaid, waypoint or place to the route.
- **Find a destination** (see [Aerodromes and briefing](./aerodromes-and-briefing.md)).
- **Import** a GPX file.

### Snapping

A tap within 20 px of a feature snaps to it. If several features are close,
a picker lists them, aerodromes first and the exact tapped position last.
While you drag a point, the preview follows the feature it would snap to,
with the nearest aerodrome preferred.

### Editing

- **Drag** a waypoint to move it, or drag a leg's midpoint to insert a new
  waypoint.
- Dropping a waypoint onto the point before or after it **removes** it
  instead of leaving a zero-length leg.
- **Reorder** waypoints by dragging them in the route table.
- **Undo and redo** any route change.
- **Reverse** the route from the menu.
- In flight, editing is locked unless you tap a leg first. See
  [Saved routes and places](./routes-and-places.md).

Direction chevrons run along each leg. Leg labels show heading and speed
when you are not editing. Intermediate waypoint names appear from zoom 8.

## The route table

Each row is a waypoint, with these columns for the leg that follows:

| Column | Meaning |
|---|---|
| MT | Magnetic track |
| MH | Magnetic heading to fly (track corrected for wind), with the wind correction angle in the tooltip. Shown when there is wind |
| TT | True track |
| NM / km | Leg distance (set in Settings) |
| Lvl | Planned altitude in feet |
| ETE | Estimated time en route |
| ETA | Estimated arrival (UTC), when a takeoff time is set |

The **ALT** row below the table is the alternate aerodrome (see below).

## Leg properties

Open a leg to override its own **altitude**, **IAS**, **wind direction**
and **wind speed**, and to add a **note**. The panel also shows the
leg's distance, magnetic and true track, **TAS**, **ground speed**, **ETE**
and its **MSA**. If the level is below the MSA a warning shows with a
button to set the level to the MSA. **Reset** drops a manual wind and goes
back to global or forecast wind.

## Takeoff time, wind and alternate

- **Departure:** set a planned takeoff date and time (UTC). Wind forecasts
  and ETAs use it. If you leave it blank, "now" is used.
- **Wind (WND):** leave blank to use the forecast per leg, or enter one
  direction and speed for all legs. A per-leg wind still wins. A refresh
  button re-fetches the forecast.
- **Alternate (ALT row):** type an alternate aerodrome's ICAO code. The row
  shows its distance from the destination. Remove it with the ✕.

Wind for each leg comes from, in priority order:

1. A wind you typed for that leg.
2. A wind you typed for the whole route.
3. The forecast wind at the middle of the leg, at the leg's altitude and
   expected time. The forecast covers about the next 16 days. Outside that,
   or offline, still air is assumed.

Time, fuel, ETAs and the pre-flight check all use the same wind values, so
they agree with each other.

## Cruise level

A new leg gets a level automatically if the default would be below the
terrain under it plus 1,000 ft, or the highest obstacle in a 1 NM corridor
plus 500 ft, rounded up to 100 ft. You are told when it happens. Legs you
set yourself, or whose endpoints you only moved, are not changed (the
pre-flight check still flags them).

## Pre-flight checks

The check lists, in a warning panel:

- **Airspace:** the planned level enters a controlled or restricted
  airspace (class C, D, restricted and TRA).
- **Below MSA:** a leg is below its minimum safe altitude (not counted near
  the departure and destination).
- **Fuel:** the minimum fuel exceeds the aircraft's capacity.

Warnings are advice. They do not replace your own planning.

## Aircraft and fuel

Pick an aircraft to get time, climb and descent, a fuel plan and a vertical
profile that match the aircraft. See [Aircraft and fuel](./aircraft-and-fuel.md)
and [Virtual Radar and vertical profile](./virtual-radar.md).

## Weather for the route

The plan can show weather and winds aloft along the route. See
[Weather and NOTAMs](./weather-and-notams.md).

## Saving and sharing

See [Saved routes and places](./routes-and-places.md) for saving, loading,
GPX and KML.
