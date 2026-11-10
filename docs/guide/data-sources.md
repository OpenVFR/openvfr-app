---
title: Data sources
description: Where OpenVFR gets its data, and its licences.
sidebar:
  order: 22
---

OpenVFR is built on open data. The full, current list with licences is on
the [credits page](https://openvfr.org/credits), and the app's map
information dialog shows the same list.

## What comes from where

| On the map | Source |
| --- | --- |
| Airspace, aerodromes, navaids, waypoints, runways | OpenFlightMaps; OpenAIP fills gaps in airspace and aerodromes |
| Obstacles (towers, chimneys, wind turbines) | OpenAIP; in Sweden also LFV and Vindbrukskollen |
| Base map, landmarks, water | OpenStreetMap, rendered from Protomaps tiles |
| Hillshade, contour lines, offline terrain | Copernicus DEM GLO-30 |
| Terrain along the route (profile, MSA) | EU-DEM via OpenTopoData |
| METAR and TAF | NOAA Aviation Weather Center |
| NOTAMs | FAA NOTAM Management Service |
| Model wind and winds aloft | Open-Meteo |
| Live traffic | OpenSky Network (ADS-B), Open Glider Network (gliders) |

Coverage and detail vary by country, following what each source publishes.

## Updates and accuracy

Each source updates on its own schedule, and updates are not guaranteed.
Aeronautical data follows the 28-day AIRAC cycle at best, so it can be
out of date or incomplete. Check official sources before every flight.
