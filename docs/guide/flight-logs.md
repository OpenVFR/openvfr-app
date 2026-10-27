---
title: Flight logs
description: Automatic flight logs, review on the profile, and GPX export and import.
sidebar:
  order: 6
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

## Reviewing a log

Open a log to replay it on the vertical profile: altitude, ground speed,
terrain, airspace and the route you planned. Drag along the track to read
time, altitude, ground speed and height above ground at any point. The
airspace shown is as drawn, for review, not as proof of an infringement.

## GPX

Export a log as GPX, or import a GPX file that has timed track points. You
choose the aircraft on import. Importing the same flight twice is refused.
