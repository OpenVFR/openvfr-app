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

## Filtering by altitude (web)

In the web app's Settings you can hide traffic far above or below you:
1,000, 2,000, 3,000, 5,000 (default) or 10,000 ft, or show all.

## Limits

- It is not a collision-avoidance system and must not be used as one.
- Reception depends on the source and your connection. If the connection
  drops, the picture stops updating and old targets disappear after a
  while.
- Traffic needs a connection to the OpenVFR server.
