---
title: Flight logs
description: Automatic flight logs, review on the profile, and GPX export and import.
sidebar:
  order: 12
---

In flying mode, OpenVFR records a log of the flight: takeoff, landing,
touch-and-go, distance, airborne time and maximum altitude.

## Circuits and the split timeout

Circuits stay in one log. When you land, the log stays open for the **Log
split timeout** (Per leg, 1, 2, 5 (default), 10 or 30 minutes). If you take
off again within it, the same log continues. Time spent parked waiting for
the timer is trimmed from the end of the log.

## Aircraft and aerodromes

A log records the aircraft selected when it starts. In the mobile app, the
flight mode sheet shows your aircraft profiles: tap one to select it, and a
warning says when none is selected. If a flight is logged without an
aircraft anyway (for example started automatically), the app asks which
aircraft flew it once the log is finished, on the ground. One tap sets it
on the log and selects it for the next flights.

Departure and arrival are where the flight started and ended. In the mobile
app that is the aerodrome within 2 NM of the takeoff and of the place you
stopped after landing, or else one of your saved places within 2 NM (a farm
strip saved under Places gets its own name). A flight that ended in the air
(lost GPS) or away from both keeps **?**; use **Rename** for those.

## When the app was closed during a flight

If the mobile app is closed or stopped before a log is finished (between
circuits, or in the air), the next start does not split the flight:

- Parked when it stopped: a takeoff within 2 NM before the **Log split
  timeout** runs out continues the same log, as if the app had stayed open.
  With *Per leg*, the log is finished at once.
- In the air when it stopped: within 10 minutes, flying mode starting again
  near where the log broke off continues it. The time in between shows as a
  recording gap.

Otherwise the log is finished at its last movement, and named from where it
started and ended.

## The log list

Filter by period (all, 30 days, 90 days, this year) and by aircraft. A
totals line sums flights, airborne time, landings and distance for what is
shown. GPS gaps are marked, and a log broken by a GPS loss can be joined
with the next part.

A flight shows in the list from takeoff, as *Recording…*, and becomes a
finished log when the split timeout after landing runs out. In the mobile
app, a track longer than about two hours is stored with fewer points (the
whole flight stays, from takeoff to landing, at a coarser spacing).

## Editing a log

- **Aircraft flown:** each log has an aircraft menu. Pick one of your
  aircraft profiles, or *No aircraft*, to set or correct it. The change
  syncs to your other devices.
- **Rename:** **✎ Rename** edits the departure and arrival (an
  aerodrome code such as `ESMI`, or a name such as a farm strip, up to 30
  characters). The aerodromes where the track starts and ends are offered
  with one tap. The change syncs to your other devices.
- **Events:** the **Events** toggle lists takeoffs, landings, touch-and-gos,
  lost GPS and airspace entered, with times. Takeoffs and landings name the
  place, for example "Takeoff from ESMI" and "Landing at ESMS": the nearest
  aerodrome within 2 NM, else one of your saved places. Away from both they
  stay plain. The names come from the aerodrome and place data on your
  device, so a flight with a stop is readable even though the log is named
  only from where it started and ended. Pick an event to open the log at
  that point.
- **Delete:** the delete button asks you to confirm with a tick or cross.
  Deleting removes the log from your account on every device.
- Simulated flights are marked **SIM**, stay on this device, are not synced
  and are not counted in the totals. On the web, **Delete simulated**
  removes them all.

## Joining two parts of one flight

If the recording broke off in the middle of a flight (GPS lost, or the app
was closed) you get two logs. The first one then shows **Join with next
part**. It appears only when:

- both logs have the same aircraft (or neither has one),
- the next log starts after the first ended, at most 10 minutes later,
- the next log was already flying at 30 kt or more in its first 10 s (a
  new takeoff is a new flight, not a continuation),
- neither is simulated or still being recorded.

You are asked to confirm. The two parts become one new log; the gap stays
marked as lost GPS. The combined log is saved before the parts are deleted,
so a failure leaves an extra log rather than losing one. A joined log
cannot be larger than 16 MB.

## Reviewing a log

Open a log to replay it on the vertical profile: altitude, ground speed,
terrain, airspace and the route you planned. Drag along the track to read
time, altitude, ground speed and height above ground at any point. The
airspace shown is as drawn, for review, not as proof of an infringement.

## GPX

Export a log as GPX, or import a GPX file that has timed track points.

A file exported from OpenVFR carries the whole log: the track, the departure
and arrival, the registration, and the route you had planned (as a normal
route, so other apps show it too). Importing it gives the same log back, and
the aircraft with that registration is preselected. Other apps may drop the
OpenVFR-specific parts when they save a file again; the track and the route
stay. A file from another app has the track only (and its route, if it has
one); the departure and arrival then come from the track in the mobile app,
as above.

You choose the aircraft on import. Importing the same flight twice is
refused.
