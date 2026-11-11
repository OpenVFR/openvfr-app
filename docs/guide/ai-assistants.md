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

## What you can ask

- "Brief my saved route Bromma to Malmö."
- "Brief a flight from ESSB to ESMS with SE-ABC at 4,500 ft."
- "What's the weather and are there NOTAMs at ESKN?"
- "Is the crosswind at ESGG OK for my aircraft right now?"
- "Where can I refuel on my route to Umeå?"
- "Add a new aircraft SE-ABC, a Cessna 182, from the attached POH."
- "Set SE-ABC's maximum crosswind to 15 kt."

A briefing gives distance, time and fuel per hop, METAR/TAF and NOTAMs at the
departure, fuel stops and destination, and the pre-flight warnings
(airspace, NOTAM areas, fuel, equipment, crosswind, runway length). Terrain
and minimum safe altitude are not checked there: open the route in the app
for those. Answers carry links into the app.

## Connect

1. In OpenVFR, open your account and copy the address under **AI assistants**.
2. Add it to your assistant as a custom connector (remote MCP server), for
   example in Claude under Customize → Connectors, in ChatGPT (paid plans)
   under the connector or plugin settings, or in Gemini under Connected apps
   where your account has it.
3. The assistant opens OpenVFR. Sign in if you are not signed in already in
   that browser (if you are, this step is skipped), then check which assistant
   asks, choose whether it may also read your **saved routes and aircraft**,
   and select **Allow**.

The approval page says whether OpenVFR could check who the assistant is:
**Verified** shows the domain that published it (for example `claude.ai`);
**Not verified** means the assistant registered itself and chose its own
name, so only allow it if you just added it yourself. Every new connection
is confirmed by email; if you did not make it, disconnect it (below).

The assistant only reads, unless you also tick **add and change your
aircraft profiles** (never preselected). Then it can add aircraft and change
their values, but never delete one. An aircraft an assistant added or changed
shows **Check before use** in the aircraft list and in the pre-flight check
until you open it in the app, compare it with the POH and save it. The
assistant never sees your flight logs or position. Only connect
assistants you trust: OpenVFR does not check them.

## Disconnect

Open your account, **AI assistants**, and select **Disconnect** next to the
assistant. It then has to ask again. You can also remove the connector in
the assistant. A connection that is not used for 90 days ends by itself.

> The assistant's answers are a planning aid, not an official briefing.
> Check the official AIP, NOTAM and weather sources before every flight.
