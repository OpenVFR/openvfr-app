---
title: Flying mode and alerts
description: Follow your GPS position in flight, the in-flight screen, auto start and stop, and how alerts behave.
sidebar:
  order: 11
---

## Starting flying mode

Open the tools menu and choose **Go flying**. You can follow:

- **GPS:** your real position. The screen stays awake while it runs.
- **Simulator:** a built-in simulator to try the app on the ground, or an
  external simulator. See [Simulators and devices](./simulators-and-devices.md).

Choose **Stop flying** to end it. Flying mode can also start and stop by
itself from takeoff and landing (see below).

While flying mode is on:

- Satellite imagery is turned off.
- Route editing is locked unless you tap a leg first.
- Some actions that change data (such as checking for data updates) are
  unavailable.

## The in-flight screen

- **Instrument bar:** ground speed, track, altitude, and the next waypoint
  with its time and distance. Tap the next-waypoint value to cycle between
  ETE and ETA. A course correction indicator shows how far you are off the
  planned leg. On native the bar is a gauges strip: GPS altitude or height
  above ground (tap to switch), barometric altitude on QNH (tap to set the
  QNH), vertical speed, ground speed, true track, UTC and wind.
- **Auto zoom:** zooms the map with your speed. Panning pauses it, and the
  map returns to your aircraft after a short countdown. A **Resume** button
  brings it back at once.
- **Orientation:** north up, track up, or course up (tap the compass).
- **Pilot log:** the route table with live ETA and actual arrival times, a
  progress bar on the current leg, upcoming frequencies (looking ahead
  about 10 minutes) and nearby VOR and NDB frequencies. See
  [Aerodromes and briefing](./aerodromes-and-briefing.md).
- **Direct to**, **Drop point**, **Brief**, the vertical profile with your
  aircraft on it, and the alert stack. See the other pages.

### Altitude

GPS reports height above the ellipsoid on Android and in browsers; OpenVFR
converts it to height above mean sea level (using a geoid model) so
airspace, terrain and obstacle margins are not too high. On native, if a
barometer or vario is connected, altitude can come from there. See
[Simulators and devices](./simulators-and-devices.md).

## Auto start and stop

Flying mode can start and stop itself from takeoff and landing. Under
**Settings → Auto flying mode**, choose:

- **Off**: never.
- **Ask** (default): a prompt suggests starting or stopping.
- **Auto**: acts immediately.

| | Rule |
|---|---|
| Start suggestion | Ground speed at or above the start speed on 5 fixes in a row (accuracy 100 m or better), while not flying. It fires once and re-arms after speed falls below the landed speed, so a car or train gives one dismissable prompt. |
| Stop suggestion | After the aircraft was seen at takeoff speed and 60 s have passed: ground speed below the landed speed on 10 fixes in a row. A slow spell right after takeoff does not trigger it. |
| After a manual stop | No new start suggestion until speed drops below the landed speed. |

The three speeds come from the aircraft's **Takeoff speed** `V`: takeoff
= V, start = V + 10 kt, landed = two thirds of V (at least 10 kt). With the
default 30 kt that is 40, 30 and 20 kt. See [Aircraft and fuel](./aircraft-and-fuel.md).

Only GPS flying mode is started or stopped this way, not simulators or
external feeds. On the web app the pre-flight position comes from the
location dot, so detection only works while location is on. Native's GPS
runs from launch, so opening the app already in the air prompts on the
first fast fix.

## Alerts

All in-flight alerts appear in one stack at the top of the map. It is
designed to stay quiet:

- Red alerts always show as a full card. Yellow alerts and notes share two
  card slots; everything else becomes a one-line chip, with "+N more"
  beyond four.
- A condition must hold for 2 seconds before its card shows, and a card
  stays at least 5 seconds. Red alerts show at once.
- **Obstacles** alert only when they are ahead on your track (within about
  0.5 NM either side, 1 to 5 NM ahead) or within 0.25 NM. Your altitude is
  compared with the tip plus 500 ft. A sustained descent is projected to
  the obstacle and the card suggests an altitude that clears it. There are
  no obstacle alerts below 30 kt ground speed. All obstacles are one
  merged card.
- **Airspace** warnings look ahead (2, 5, 10 or 15 minutes; default 5)
  and use a vertical buffer (default 500 ft; set 0 to warn only on
  climb/descent projections). Each category has a level: **Alert** (a red or
  yellow card), **Info** (a quiet blue chip) or **Ignore**. Defaults:
  restricted, class A and B/C/D Alert; E/F Ignore; zones and glider/other
  Info. Restricted areas and class A can be set to Info but never Ignore.
  Several yellow airspaces at once merge into one "N airspaces" card.
- **Entered and left** notices for airspace have their own switch.
- **Aerodrome nearby** (within 1 NM and 1,500 ft, not on the route) only
  alerts while a route with two or more waypoints is planned.
- **NOTAM circles** you are about to enter can alert as well. Several merge
  into one card.
- **Planned course:** with *Mute airspace warnings on planned course* on,
  yellow and blue airspace warnings are hidden while you move within 1 NM
  of a route leg and track within 30° of it. Red hazards always show.
- **Dismissal:** a dismissed alert stays muted while the hazard is still
  detected, and can alert again after it has been absent for 60 s.
- **Recent alerts:** a "↺ N recent" pill under the stack lists everything
  from the last 30 minutes (time in UTC, newest first).

Under **Settings → Alert banners** you can switch banner types off and set
the warning level per airspace category.

> Alerts are an aid to awareness. They can be late, missing or wrong (for
> example when GPS accuracy is poor or data is out of date). They do not
> replace looking out, your charts and your own judgment.
