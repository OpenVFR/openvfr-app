---
title: Flying mode and alerts
description: Follow your GPS position in flight, auto start and stop, and how alerts behave.
sidebar:
  order: 5
---

## Flying mode

Flying mode follows your GPS position. It can start and stop by itself
from takeoff and landing. Under **Settings → Auto flying mode**, choose:

- **Off**: never.
- **Ask** (default): a prompt suggests starting or stopping.
- **Auto**: acts immediately.

Detection uses your aircraft's takeoff speed. Only GPS flying mode is
started or stopped this way, not simulator or external feeds.

## Alerts

All in-flight alerts appear in one stack at the top of the map. It is
designed to stay quiet:

- Red alerts always show as a full card. Yellow alerts and notes share two
  slots; everything else becomes a one-line chip.
- A condition must hold for 2 seconds before its card shows, and a card
  stays at least 5 seconds. Red alerts show at once.
- **Obstacles** only alert when they are ahead on your track, and not
  below 30 kt ground speed.
- **Airspace** warnings have a level per category: Alert, Info or Ignore.
  Restricted areas and class A can be quietened but never ignored.
- **Planned course:** you can mute yellow and blue airspace warnings while
  you are tracking your route. Red hazards always show.
- Dismissed alerts stay muted while the hazard is still detected.
- A "recent" pill under the stack lists alerts from the last 30 minutes.

Under **Settings → Alert banners** you can switch banners off and set the
warning level per airspace category.
