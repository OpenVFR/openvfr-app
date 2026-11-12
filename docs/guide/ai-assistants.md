---
title: AI assistants
description: Ask your own AI assistant about your routes, aerodromes, weather and NOTAMs.
sidebar:
  order: 17.7
---

You can connect your own AI assistant to OpenVFR and ask it, typed or
spoken, about your flight: for example on the way to the airfield. The
assistant reads the same data the app uses and answers in its own words.
The connection is available when your OpenVFR server offers it; your account
panel then has an **AI assistants** section.

## Where it appears in the app

When your account is offered the assistant connection, a small sparkle
button opens a short help with the setup steps, the connector address (copy it
on the web; select it or use **Share address** on the phone) and example
questions you can copy: on the web next to the aircraft chip of the route
section and at the top of the aircraft and flight log sections, on the phone
in the route screen's header and under **Use your AI assistant** in Settings.

## What you can ask

- "Brief my saved route Bromma to Malmö."
- "Brief a flight from ESSB to ESMS with SE-ABC at 4,500 ft."
- "What's the weather and are there NOTAMs at ESKN?"
- "Is the crosswind at ESGG OK for my aircraft right now?"
- "Where can I refuel on my route to Umeå?"
- "Add a new aircraft SE-ABC, a Cessna 182, from the attached POH." (a model with deep thinking reads the POH's tables and diagrams best)
- "Set SE-ABC's maximum crosswind to 15 kt."
- "Plan ESSB to ESMS with SE-ABC at 3,500 ft, with a fuel stop at ESKN, and save it."
- "On my route to Umeå, fly via ESNS and climb to 4,500 ft on the last leg."
- "Save my cabin at 59.50 17.93 as a place and plan a route there from ESSB."
- "How many hours have I flown in the last 90 days, and when was my last flight?"
- "Draft the ICAO flight plan for my route to Visby with SE-ABC, departing 09:30 UTC, two on board." (it drafts the text and lists what is missing; it does not file anything)
- "Which altitudes should I fly on my route to Visby? I want to stay below the TMAs where terrain allows."

Many assistants also offer OpenVFR's prompts in their prompt or attachment
menu: **Pre-flight briefing** (give a saved route name or ICAO codes) and
**Plan a VFR route** (departure, destination, optionally aircraft and
wishes such as "stay below the TMAs"); the assistant then runs the tools in
the right order.

A briefing is for your planned departure: the time you give the assistant,
else the departure set in the app if it is still ahead, else now. It gives
distance, time and fuel per hop with the wind on each leg (set on the leg,
your global wind setting, or the forecast at the leg's altitude and time),
the time at each aerodrome, METAR, the TAF for the time you are there and
NOTAMs in force then at the departure, fuel stops and destination, weather
reported along the way, a daylight check (departure before sunrise, landing
after sunset), "also check" items such as a border crossing, the pre-flight warnings (airspace,
NOTAM areas, terrain and minimum safe altitude, fuel, equipment, crosswind,
runway length), each with the leg it concerns, and the altitude per leg
(below). Your own MSA margins and airspace alert levels from Settings are
used. Answers carry links into the app.

### Altitudes per leg

For each leg the assistant gets the minimum safe altitude (terrain from the
same elevation model the app uses, or else the conservative terrain grid,
plus obstacles and your MSA margins), the controlled airspace above it (where
along the leg, floor, ceiling, frequency), control zones crossed, restricted
areas, and what sets the MSA (the highest terrain, or the obstacle with its height
and position), and a suggested altitude: at or above the MSA, below controlled
airspace where possible, and on a VFR cruising level (odd thousands + 500 ft
eastbound, even westbound, above 3,000 ft over the ground). When one altitude
does not fit the whole leg it suggests changing level on the way; when the
MSA reaches controlled airspace it says so and offers a clearance (with the
frequency) or a route around it. It never suggests flying below the MSA. You can still decide to: the
assistant then has to tell you the MSA and what sets it, and saves the lower
level only after you confirm; the pre-flight check keeps warning about it.
Levels below the legal minimum height (500 ft above the highest ground or
obstacle within 150 m of the track) are not saved from an assistant; set
those in the app. The rule over towns (1,000 ft above obstacles within
600 m) is not checked.
With an aircraft, a new route can also get the best fuel stop added when a
hop is too long.

## Connect

1. In OpenVFR, open your account and copy the address under **AI assistants**.
2. Add it to your assistant as a custom connector (remote MCP server), for
   example in Claude under Customize → Connectors, in ChatGPT (paid plans)
   under the connector or plugin settings, or in Gemini under Connected apps
   where your account has it.
3. The assistant opens OpenVFR. Sign in if you are not signed in already in
   that browser (if you are, this step is skipped), then check which assistant
   asks, choose whether it may also read your **saved routes, places and
   aircraft** (and, if it asks, change them or read a **summary of your logged
   flights**: see below), and select **Allow**. To give a
   connected assistant more access later, disconnect it and connect again.

The approval page says whether OpenVFR could check who the assistant is:
**Verified** shows the domain that published it (for example `claude.ai`);
**Not verified** means the assistant registered itself and chose its own
name, so only allow it if you just added it yourself. Every new connection
is confirmed by email; if you did not make it, disconnect it (below).

Changing anything needs reading your saved routes, places and aircraft too (the
change tick boxes are greyed out without it). The assistant only reads, unless you also tick **create and change your
saved routes and places** or **add and change your aircraft profiles** (never
preselected). Then it can save new routes and change routes (points,
altitudes, speeds, fuel stops, aircraft, name), save and change places
(name, position, folder), or add aircraft and change their values, but
never delete anything. The assistant never sees your position or your GPS
tracks.

### Places and flight summaries

With access to saved routes it can list your **places** (the named
positions you saved on the map) and use one as a route point, written
`PL/<name>`. A place it saves or moves reaches your devices at the next sync;
check its position on the map before you rely on it (unlike routes and
aircraft, places carry no "check before use" mark). Place names must be
unique.

If you tick **a summary of your logged flights** (never preselected), the
assistant can list your flights (date, aircraft, departure and arrival
aerodrome, flight time, distance, highest altitude) and give totals for the
last 30 days, 90 days and 12 months, per aircraft. It never gets the track
or any position. It counts logged flights, not take-offs and landings, so
whether you are current is for you and your authority to judge. Only
flights in your OpenVFR logbook count, and only completed ones that were not
recorded in a simulator.

### Routes and aircraft from an assistant

Name the aircraft in your request ("plan with SE-ABC"). If you don't, the
assistant plans with the aircraft selected in the web app (or your only
aircraft profile) and says which; with several and none selected it asks.
The selection made in the mobile app stays on the phone, so it is not used
here.

Route points are aerodrome codes, navaids, reporting points (written
`ESSB/LAVER` when several aerodromes have one with that name), named
landmarks such as churches and water towers (`LM/Hassela kyrka`) or
coordinates; OpenVFR refuses anything it does not know rather than guess.
To find a way around something the assistant can look up points near a
place, along a leg, or just outside a TMA or control zone, each with the
controlled airspace above it. Landmarks come from OpenStreetMap: check that
one is visible from the air before turning there.
After each change the assistant gets the route's briefing warnings, so it can
improve the route, and a link that opens the route in the app.

A route or aircraft an assistant made or changed shows **Check before use**
in the list and in the pre-flight check. Open it, check every point, level
and fuel stop (or the values against the POH), and save it: that removes the
mark. If the route was changed while you had it open, the route list says the
map shows another version; load the saved route to see the change. Only connect
assistants you trust: OpenVFR does not check them.

## Disconnect

Open your account, **AI assistants**, and select **Disconnect** next to the
assistant. It then has to ask again. You can also remove the connector in
the assistant. A connection that is not used for 90 days ends by itself.

> The assistant's answers are a planning aid, not an official briefing.
> Check the official AIP, NOTAM and weather sources before every flight.
