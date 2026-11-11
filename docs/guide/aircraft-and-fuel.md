---
title: Aircraft and fuel
description: Aircraft profiles, what each field does, and how the fuel plan is calculated.
sidebar:
  order: 7
---

An **aircraft profile** holds the performance numbers OpenVFR uses for
leg times, climb and descent, the vertical profile and fuel. Pick one for
your route to get a fuel plan and an accurate profile. Without one the app
still plans the route, but it cannot tell you fuel or realistic climbs.

## Managing aircraft

Open the aircraft list from the planning panel. You can:

- **Create** a new aircraft, or **duplicate** an existing one as a start.
- **Edit** or **delete** (with a confirmation step).
- **Select** the aircraft used for the current route. Tap again to deselect.
- **Fill from a POH with your own AI assistant (web and mobile):** in the
  aircraft form, choose **AI** (web) or **Fill from POH with your AI
  assistant** (mobile). Copy or share the prompt, open the AI chat assistant
  you already use (any assistant that reads PDF files), attach the POH and
  send the prompt. Copy the whole answer, paste it back into the form and
  choose **Fill in the form**. The PDF goes only to your assistant, not to
  OpenVFR, and no OpenVFR account is needed. The app checks the numbers it
  gets: a field the answer did not contain, or a value that looks wrong
  (out of range, or not consistent with another field, such as a reserve
  larger than the tank), is marked for you to check. On the web the page
  the assistant read a value from shows when you hover the field.
- **Import a POH PDF on the server (web only, where the server offers it):**
  upload the performance pages as a PDF and the server proposes values.
  This needs an account and sends the document to the cloud service the
  server is configured with. Fields it could not find are flagged with a
  `?`.

  Whichever way you import, check every value against your own
  documentation before you save.

Profiles sync between your devices when you are signed in.

## The fields

All speeds are indicated airspeed (IAS) in knots, fuel is in litres.

**Identity**
- **Name**, **Registration** (for example SE-ABC), **ICAO type** (for
  example C172).
- **Category:** single engine piston, multi engine piston, microlight/ULM,
  gyroplane, helicopter, touring motor glider, or glider. The category
  gives sensible defaults and the right silhouette on the chart.

**Cruise**
- **Cruise altitude:** the typical level, used when a leg has none.
- **Cruise IAS:** used for leg times and the wind triangle.
- **Takeoff speed:** ground speed at which the aircraft lifts off. It
  drives automatic start and stop of flying mode and flight-log
  detection. Leave 0 to use the category default. See
  [Flying mode and alerts](./flying-and-alerts.md).

**Runway**
- **Min runway** (m): the shortest runway you accept for this aircraft.
  0 means no limit.
- **Paved only:** only asphalt or concrete runways.
- **Max crosswind** (kt): the maximum demonstrated crosswind from the POH,
  used by the pre-flight crosswind check. 0 means not set.
- **T/O dist 50 ft** and **LDG dist 50 ft** (m): the POH's take-off
  distance over a 50 ft obstacle and landing distance from 50 ft, at
  maximum mass, sea level, standard temperature, on a paved dry runway.
  The app scales them for each aerodrome: +10 % per 1,000 ft of
  elevation, +10 % per 10 °C above standard temperature (when the
  aerodrome reports its temperature), +20 % for take-off and +15 % for
  landing on grass or another unpaved surface, then a safety factor of
  1.33 for take-off and 1.43 for landing. Wind and slope are not counted.
  The pre-flight check warns when the best runway at the departure,
  destination or a fuel stop is shorter, and fuel-stop suggestions skip
  aerodromes where the aircraft could not land and take off again. 0 means
  not set. These are planning factors only: the POH's tables for the
  day's mass and conditions decide.

**V-speeds** (kt IAS, 0 means not set)
- **Vs0** (stall, landing flaps), **Vs1** (stall, clean), **Vx** (best
  angle of climb; Vy is the climb IAS), **Vfe**, **Va**, **Vno**, **Vne**.
  The POH import fills them and marks values out of the usual order
  (Vs0 ≤ Vs1 < Vfe ≤ Vno < Vne).
- Both preset the filters of the destination finder, and are used when the
  app suggests aerodromes.

**Equipment**
- **Transponder** (none, mode A, C or S) and **Radio** (yes or no). Leave
  them **Not set** if you prefer; set to none or no, the pre-flight check
  treats a TMZ (no transponder) or an RMZ or controlled airspace (no radio)
  on the route as a hard stop.

**Fuel**
- **Fuel types:** the grades the engine is approved for (AVGAS 100LL,
  AVGAS UL91, MOGAS, JET A-1), in order of preference: the first is the
  one you prefer (numbered 1), the others are approved alternatives. Tap a
  grade to add it, tap a chosen one to remove it, and use the arrow to move
  it up. Fuel-stop suggestions favour aerodromes with your preferred fuel
  and say when a stop only has a later choice. With at least one set, the destination
  finder starts with the **Aircraft** fuel filter: aerodromes that list a
  matching fuel. Fuel listings come from the published aerodrome data and
  can be out of date: check the AIP or call ahead.
- **Burn** (L/h) at cruise.
- **Max capacity** (L), usable.
- **Unusable** (L): unusable fuel, not part of the capacity. Shown in the
  fuel plan for reference.
- **Taxi / T/O** (L): start, taxi and takeoff roll.
- **Reserve LDG** (L): fixed landing reserve.
- **Holding** (min) at cruise burn.
- **Diversion** (min) at cruise burn. Default 30.
- **Final reserve** (min) at cruise burn, on top of the other reserves
  (for example 30 min for day VFR). 0 means none.
- **Contingency** (%) of the en-route fuel.

**Climb and descent**
- **Service ceiling**, **rate of climb at sea level** and **at ceiling**,
  **climb IAS**, optional **climb fuel burn** at sea level and **climb
  burn at ceiling** (the burn is scaled between the two with altitude; 0
  uses the sea-level burn all the way).
- **Descent rate** (positive number), **descent IAS**, optional **descent
  fuel burn**.
- Without these the whole trip is treated as cruise.

**Glide**
- **Best glide IAS** and **glide ratio** (for example 30 for 30:1). Used to
  show which aerodromes are reachable in a glide (see
  [Aerodromes and briefing](./aerodromes-and-briefing.md)).

## The fuel plan

For a route with an aircraft the plan lists:

| Item | What it is |
|---|---|
| Taxi / start | Fixed amount from the profile |
| Climb, cruise, descent | En-route fuel by phase, with the time in each |
| Contingency | The percentage of en-route fuel |
| Holding | Holding minutes at cruise burn |
| Diversion | Diversion minutes at cruise burn |
| Landing reserve | Fixed amount from the profile |
| Final reserve | Final reserve minutes at cruise burn, when set |
| **Min required** | Sum of all of the above |
| **Available** | Maximum capacity of the aircraft |
| Unusable | Unusable fuel, when set (not in Available) |

The plan uses true airspeed at each leg's altitude and the effective wind
of each leg, so its times match the route table. Climb and descent
distance is taken off the cruise distance. If **Min required** exceeds
**Available**, the pre-flight check warns you.

## Fuel stops

A route point can be a **fuel stop**: you land there and refuel. Open the
leg that ends at the point and tick **Land and refuel at ...** (on the
mobile app: the leg's override panel); the point shows **FUEL** in the
route table (on the web, select it to fly through instead). The
fuel plan then has one part per hop, each starting with full tanks and its
own taxi fuel and reserves, and the pre-flight check tests each hop.

When the fuel is short, the fuel plan offers **Suggest fuel stop**. It
looks for aerodromes within about 25 NM of the route that list a fuel your
aircraft can use and have a runway it accepts (the aircraft's fuel types,
minimum runway and paved-only settings), and picks the stops that split
the trip into hops the tanks can cover. It prefers stops that add little
flying time, hops of similar length and some spare fuel on each hop, and
shows up to three options with each hop's time and the fuel left on
landing. **Add to route** inserts the stops as fuel stops; one undo
removes them again. Fuel listings come from the published aerodrome data
and can be out of date: check the AIP, opening hours and NOTAMs, or call
ahead.

> The fuel plan is a planning aid. Compare it with your POH, weigh and
> balance, and company or national requirements.
