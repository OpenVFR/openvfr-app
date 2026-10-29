---
title: Troubleshooting
description: Common problems and what to try.
sidebar:
  order: 20
---

## The map is empty or broken

- Check your connection and reload. If it stays broken on the web app, use
  **Settings → App → App files → Repair & reload**. Your routes, aircraft,
  places, logs and settings are kept.
- On native, check **Settings → Offline data**: a download that was
  interrupted can leave incomplete data. Update the offline data again.
- Check that the correct **country** is active.

## Airspace or aerodromes look out of date

See the AIRAC row in Settings. If it says the data is out of date, update
(web: reload when prompted or check the Data versions row; native: update
offline data). Always verify against current official sources.

## No weather, NOTAMs or traffic

These need a connection to the OpenVFR server and a signed-in account.
Check your connection and sign in again. Weather may also be briefly
unavailable when the weather service is busy: the last good value is
shown when there is one. Station weather, METAR and the model-based
*Weather station* are separate sources: if one has nothing, try the other.

## Forecast wind is missing

The forecast covers about the next 16 days from now. Outside that, or
offline, still air is used. Enter a wind by hand if you need one.

## GPS does not start, or the position jumps

- Allow location access for the app or site, and turn location on.
- On the web app, a browser tab can be suspended with the screen off. For
  reliable tracking use the native app, which runs a background service.
- Indoors or with poor accuracy the position can wander. Alerts use the
  fix accuracy: very poor fixes do not start auto flying mode.

## Flying mode did not start or stop by itself

Check **Settings → Auto flying mode** (it must not be Off) and the
aircraft's **Takeoff speed**. On the web app, location must be on before
takeoff.

## Altitude looks wrong

GPS altitude is converted to height above mean sea level, but it is still
GPS: it can be off by tens of feet and does not track pressure. Airspace
limits are published against pressure, so a few hundred feet of difference
is possible. On native you can use a barometer or vario and set the QNH.
See [Simulators and devices](./simulators-and-devices.md).

## A saved route or aircraft is not on my other device

Sync needs a connection and the same account. A row the server refused
(too large, or an account limit) stays on its device, with a note that
explains. Sign out and in again if sync seems stuck.

## An alert did not show, or shows too often

See [Flying mode and alerts](./flying-and-alerts.md): alerts wait 2 s,
merge, and can be muted by the planned-course option or by a category set
to Info or Ignore. Check **Settings → Alert banners** (web: **Warnings & margins**).

## I cannot change a route, or turn on satellite, in flight

By design. Route editing is locked unless you tap a leg first, and the
satellite basemap is planning-only. Stop flying mode to change them.

## Install, update and reset

- **Web app update:** a prompt appears when a new version is ready. Accept
  it, or reload.
- **Native:** update from the store.
- **Delete everything:** see [Account and sync](./account-and-sync.md).

Still stuck? Open an issue in the project's GitHub repository.
