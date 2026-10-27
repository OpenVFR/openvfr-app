---
title: Weather and NOTAMs
description: METAR, TAF, wind, cloud and NOTAMs, and how to read them.
sidebar:
  order: 10
---

## METAR and flight category

Weather for aerodromes uses these colours:

| Category | Colour | Condition |
|---|---|---|
| VFR | green | Ceiling at or above 3,000 ft and visibility at least 5 nm |
| MVFR | blue | Ceiling 1,000 to 3,000 ft, or visibility 3 to 5 nm |
| IFR / LIFR | red | Ceiling below 1,000 ft, or visibility below 3 nm |
| Unknown | magenta | No data, or data older than 2 hours |

The category is a quick reading, not a weather minimum. Apply your own
limits and the regulations that apply to you.

## TAF

The forecast is shown as an hour-by-hour timeline: flight category, sky,
visibility, ceiling and wind for each hour. The decoded change groups (FM,
BECMG, TEMPO) and the raw text are shown with it.

## Cloud and wind on the card

- **Cloud profile:** the reported layers on an altitude scale, with a cloud
  symbol at each base.
- **Wind gauges:** a compass with the runway across it, and a speed dial.
  Choose the runway to see the head and crosswind.
- **Weather station:** a model-based reading at the aerodrome, an
  alternative to the METAR. It is a model, not an observation.

## Weather along the route

The route's vertical profile shows cloud layers from the stations near the
route and winds aloft at several levels. See
[Virtual Radar and vertical profile](./virtual-radar.md).

## Wind

Model wind is shown as arrows on the map, in the vertical profile and per
leg on a planned route. See [Planning a route](./planning-a-route.md) for
how leg wind is chosen. If the wind service is busy, the last good value is
shown rather than nothing.

## NOTAMs

NOTAMs come from the worldwide NOTAM service. Coverage depends on that
source: it is not a substitute for official national NOTAM and AIP sources.

- **On the map:** regional NOTAMs with a position and radius are drawn as
  circles you can switch on in the layers.
- **Per aerodrome:** the NOTAM tab of the aerodrome card.
- **Regional list:** notices for the whole FIR that have no useful
  position. Only the FIRs that cover your position, route or aerodrome are
  included, so a country-wide notice from a far-away country does not clutter your
  briefing.
- **Near your route:** lists are narrowed to NOTAMs within about 5 NM of the
  route. The map still shows everything active while you pan.
- **VFR only** (on by default) hides NOTAMs marked as IFR-only. Anything
  with an unknown traffic type is kept. Nothing is dropped silently: lists
  say how many are hidden.
- **Short / Full / Raw:** a decoded summary, the full text with validity
  and schedule, or the ICAO item layout.
- **Expand abbreviations** decodes ICAO shorthand in the text.
- Tapping a NOTAM dims it for the session so you can see what you have
  read. It stays visible.
- A banner appears when the NOTAM data is more than 1 hour old.

In flying mode, NOTAM circles that you are about to enter can raise alerts.
See [Flying mode and alerts](./flying-and-alerts.md).
