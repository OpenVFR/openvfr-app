---
title: Planning a route
description: Build a route, edit legs, and see heading, wind correction, time and fuel.
sidebar:
  order: 5
---

## Building the route

Add waypoints by tapping or clicking the map, by searching, or (web)
by typing the whole route as text (for example `ESOS ESGG ESSA`). Other ways:

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
- **Undo and redo** any route change (web: Ctrl+Z, Ctrl+Shift+Z; see [Keyboard shortcuts](./keyboard-shortcuts.md)).
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

On the web app the check lists, in a warning panel (native marks legs
below their MSA in red and warns when fuel is short, but has no airspace
check in the plan):

- **Airspace:** the planned level enters a controlled or restricted
  airspace (class C, D, restricted and TRA).
- **Below MSA:** a leg is below its minimum safe altitude (not counted near
  the departure and destination).
- **Equipment:** the route enters a TMZ and the aircraft profile says it
  has no transponder, or an RMZ or controlled airspace (class A to D) and
  the profile says it has no radio. Shown as a hard stop; with the
  equipment fitted or not set, the normal airspace reminder appears.
- **Fuel:** the minimum fuel exceeds the aircraft's capacity, per hop when
  the route has fuel stops.
- **Runway length:** with the aircraft's take-off and landing distances
  set, the best runway at the departure (take-off), destination (landing)
  or a fuel stop (both) is shorter than the scaled distance (see
  [Aircraft and fuel](./aircraft-and-fuel.md)).
- **Crosswind:** at the departure, destination or a fuel stop, the wind the
  aerodrome reports now (METAR, gusts included) gives more crosswind on its
  best runway than the aircraft's maximum demonstrated crosswind. Check
  the forecast for your arrival time.
- **Over water beyond gliding distance:** for a single-engine aircraft, the
  part of the route over the sea or a large lake where it could not glide to
  land from the planned altitude. It shows how far from land the route gets,
  the glide distance from your altitude in still air (glide ratio from the
  aircraft profile, or a typical one, marked as assumed), and the altitude
  needed to reach land. If the leg has a wind (set on the leg, your global
  wind setting or the forecast), the check includes it: the wind moves the
  area you can reach downwind during the glide (the time depends on the
  aircraft's best glide speed, or 70 % of cruise speed when that is not
  set), so land upwind is reached less far and land downwind further.
  Beyond gliding distance, life jackets are required for everyone on board.
  Only large lakes (about 10 km² and up) are checked, from a small lakes
  file of the country; a country without one is checked over the sea only.
  Land outside the terrain grid of your countries is not seen. Gusts, turns and the time to set up a glide are not modelled.

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
GPX.

## The Plan screen on native

On native, planning has its own screen with four segments along the top:

- **Route:** the route table with wind (manual, global or forecast), takeoff
  time (UTC), alternate, the pre-flight warnings above, **Raise to MSA** and
  the fuel plan. The **⋯** button in the header opens the route actions
  (route library, export, import, reverse, close route).
- **Aircraft:** your aircraft profiles. **Add Aircraft…** creates one; each
  profile can be selected, edited, duplicated and deleted. See
  [Aircraft and fuel](./aircraft-and-fuel.md).
- **Places:** your saved places in folders. Search, add by coordinates,
  import and export GPX, and per place: add to the route, insert into the
  route, start a new route from it, show on the map, edit or delete. See
  [Saved routes and places](./routes-and-places.md).
- **Logs:** your flight logs, with import and export of GPX, a period and
  aircraft filter, and joining. See [Flight logs](./flight-logs.md).

## ICAO flight plan

With a route and an aircraft selected, **Export ICAO flight plan…** (in the route's ⋯
actions menu, next to GPX) opens a form with what the
plan needs that is not in the route or the aircraft, and builds the plan as
text:

- **Aircraft details for the plan:** registration, ICAO type, colour,
  transponder and radio / nav. Fill in what the list says is missing and save
  it to the aircraft profile, so you only do it once.
- **Other information:** persons on board not known yet
  (written TBN; tell the ATS before taxiing) and life jackets carried without
  light, fluorescein or radio (written as the remark JACKETS).

- **Asked per flight:** flight rules (V, I, Y, Z), type of flight (G for
  private flying), off-block time in UTC, alternate, persons on board, your name
  and phone, emergency radio, survival equipment, life jackets, life rafts (dinghies) and
  remarks. The pilot name and phone and the emergency equipment are
  remembered for the next flight.
- **From the aircraft and route:** registration, type and wake category,
  equipment and surveillance, cruise speed (true airspeed), the route as
  degrees and minutes (aerodromes by their code), the flight time (rounded up)
  with the leg winds, endurance from usable fuel and fuel burn, colour and
  markings.
- **Level in the plan:** **VFR** (the default) writes the word VFR; **Planned
  levels** writes the first leg's level and, after each route point where the
  level or speed changes, the new speed and level (for example
  `/N0107A045`). Levels are written as altitudes (A, hundreds of feet on
  QNH) as you planned them. OpenVFR does not convert them to flight levels:
  at or above the transition altitude (see ENR 1.7 of the national AIP) a
  level is a flight level on the standard pressure setting, so change those
  by hand; the check list reminds you.
- **Output:** the message `(FPL-…)`, the same message with item 19 inside it
  (for a filing form that has an import box where you paste a whole message),
  and the item 19 lines, each with a Copy
  (web) or Share (mobile) button, and a **Check before you file** list of what
  is missing: for example no registration, a type that is not a valid
  designator (the plan then uses ZZZZ and puts your text after `TYP/`), more
  type of flight X without an explanation, an off-block time less than 5
  minutes or more than 5 days ahead, a phone number that does not start with
  `+` and the country code, endurance shorter than the flight time, the
  destination used as the alternate, or life rafts without capacity and
  colour. Accents and characters the aeronautical network does not carry are
  removed from names, colours and remarks.

OpenVFR does not send the plan. Copy it into the filing service you use (the
ATS provider's form or message window) and check it there; it is a draft, not
an official document.
