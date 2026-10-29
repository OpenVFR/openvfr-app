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

## The log list

Filter by period (all, 30 days, 90 days, this year) and by aircraft. A
totals line sums flights, airborne time, landings and distance for what is
shown. GPS gaps are marked, and a log broken by a GPS loss can be joined
with the next part.

## Editing a log

- **Aircraft flown:** each log has an aircraft menu. Pick one of your
  aircraft profiles, or *No aircraft*, to set or correct it. The change
  syncs to your other devices.
- **Events:** the **Events** toggle lists takeoffs, landings, touch-and-gos,
  lost GPS and airspace entered, with times. Pick one to open the log at
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

Export a log as GPX, or import a GPX file that has timed track points. You
choose the aircraft on import. Importing the same flight twice is refused.
