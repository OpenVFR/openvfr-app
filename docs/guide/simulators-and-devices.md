---
title: Simulators and devices
description: Practise with the built-in simulator, connect X-Plane or MSFS, and use a barometer or vario (native).
sidebar:
  order: 14
---

## Built-in simulator

Choose **Go flying** and then the simulator instead of GPS. It moves an
aircraft on the map so you can try planning, alerts and the profile on the
ground.

- **Web:** steer with the keyboard. Arrow left and right turn, arrow up and
  down change speed, **+** and **−** change altitude, and **Q** jumps 1 NM
  ahead along your heading. You can also drag the aircraft to a new place.
  Keys are ignored while you type in a field.
- **Native:** touch controls. Heading, speed and altitude **+/−** buttons
  apply one step per tap, and holding a button repeats at an increasing
  rate. **ADV +1NM** jumps ahead.

### Simulated flights and the logbook

Simulated positions never enter your real logbook. A flight log is only
created from simulator or external positions if **Log simulated flights**
is on in Settings, and then it is marked as simulated: it is never synced,
and is left out of your totals. On native you can delete all simulated logs
from Settings.

## X-Plane and MSFS

You can feed OpenVFR a position from a desktop simulator.

**Native (direct):** in Settings → Simulator, choose one of:

- **UDP auto-detect:** tap *Listen on UDP 49002*. In X-Plane enable
  *Settings → Network → Broadcast to all mapping apps*. For MSFS use an
  add-on that broadcasts the same format. No IP address is needed on the
  same network.
- **WebSocket bridge:** run the bridge script on the simulator PC and enter
  its address (`ws://<pc-address>:5104`). Use it when UDP is blocked or the
  source only sends TCP NMEA. It accepts the X-Plane format and NMEA
  (`$GPRMC` and `$GPGGA`).

**Web:** browsers cannot receive UDP, so the web app connects to the
WebSocket bridge only. The bridge script is `nmea-ws-bridge.mjs` in the
`openvfr-app` repository (`apps/web/scripts`).

External simulator flights are not logged unless *Log simulated flights* is
on.

## External GPS and receivers (native)

Native can read GDL90 data (for example from a portable ADS-B receiver over
its Wi-Fi on UDP 4000) as a source of position and traffic. *Support and
exact behaviour of receiver inputs may vary by device.*

## Barometer and vario (native)

By default altitude comes from GPS. Two optional sources can improve it:

- **Internal barometer** (Settings → Vario): uses the phone's pressure
  sensor, off by default. Phone barometers measure the pressure where the
  phone is (a pocket or a cabin), which can differ from the outside
  pressure, so a warning explains this before you turn it on. A first-run
  prompt offers it once, when a sensor is detected. On iOS the system asks
  for Motion and Fitness permission.
- **BlueFly vario** over Bluetooth: connects to the external instrument and
  its reading takes priority. You can set it to reconnect automatically.

The order of priority is: BlueFly vario, then the internal barometer (if
enabled), then GPS.

### QNH

Barometric altitude needs a QNH. In Settings you can choose **QNH source**
and **QNH**:

- **Automatic:** QNH worked out from the METARs of nearby aerodromes, with
  closer stations counting more.
- **Field calibration:** while parked at a known aerodrome, the phone
  barometer can calibrate QNH. It is only a fallback, kept for about an
  hour after takeoff, and a live METAR-derived value always wins.
- **Manual:** set it yourself. The default is 1013.25 hPa.

Other altitude settings: show height above ground instead of above sea
level, show QNH on the pressure altitude gauge, and show local time.
