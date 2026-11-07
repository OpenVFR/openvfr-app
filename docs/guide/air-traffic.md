---
title: Air traffic
description: Live traffic on the map, where it comes from and how to read it.
sidebar:
  order: 13
---

Turn on **Air Traffic (ADS-B)** in the layers to see aircraft around you.

## Where it comes from

Traffic comes from public ADS-B data and from glider networks (FLARM/OGN),
collected by the OpenVFR server and sent to your device. It is a picture of
aircraft that broadcast their position, not a complete list: aircraft
without a transponder or ADS-B out, and aircraft out of reception range, do
not appear.

The server updates about once a minute. Your device moves each aircraft
forward from its last speed, track and vertical rate in between, so the
symbols move smoothly. An aircraft not seen for a while is removed.

## Reading the symbols

Symbols follow the aircraft type (for example light aircraft, helicopter or
glider) and whether it is airborne or on the ground. Tap a symbol to see
its details.

## Filtering by altitude

With Air Traffic on, a **Traffic vertical filter** slider appears under it
(in Layers on the web, in Map display on the native app). Drag it to hide
traffic far above or below you, from ±1,000 to ±10,000 ft in 500 ft steps
(default ±5,000 ft), or All.

The filter works in flying mode, relative to your altitude. When you are not
flying, all traffic is shown, so you can use the map like a flight radar. On
the web, each target is then labelled with its own altitude (for example
4,500 ft) instead of the difference to you, and proximity colours and beeps
are off.

## Limits

- It is not a collision-avoidance system and must not be used as one.
- Reception depends on the source and your connection. If the connection
  drops, the picture stops updating and old targets disappear after a
  while.
- Traffic needs a connection to the OpenVFR server.
