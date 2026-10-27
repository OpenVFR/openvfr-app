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
- **Import from a POH:** upload the performance pages as a PDF and the app
  proposes values. Fields it could not find are flagged with a `?`: always
  check those against your own documentation. Importing needs an account
  and sends the document to a cloud service for extraction.

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

**Fuel**
- **Burn** (L/h) at cruise.
- **Max capacity** (L), usable.
- **Taxi / T/O** (L): start, taxi and takeoff roll.
- **Reserve LDG** (L): fixed landing reserve.
- **Holding** (min) at cruise burn.
- **Diversion** (min) at cruise burn. Default 30.
- **Contingency** (%) of the en-route fuel.

**Climb and descent**
- **Service ceiling**, **rate of climb at sea level** and **at ceiling**,
  **climb IAS**, optional **climb fuel burn**.
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
| **Min required** | Sum of all of the above |
| **Available** | Maximum capacity of the aircraft |

The plan uses true airspeed at each leg's altitude and the effective wind
of each leg, so its times match the route table. Climb and descent
distance is taken off the cruise distance. If **Min required** exceeds
**Available**, the pre-flight check warns you.

> The fuel plan is a planning aid. Compare it with your POH, weigh and
> balance, and company or national requirements.
