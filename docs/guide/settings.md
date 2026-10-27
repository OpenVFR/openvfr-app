---
title: Settings reference
description: Every setting, what it does and its default.
sidebar:
  order: 17
---

Settings are on the web app's Settings panel and on native's Settings
screen. Both sync with your account. Where the platforms differ, it is
noted.

## Units and display

| Setting | Options | Default | Notes |
|---|---|---|---|
| Distance | NM, km | NM | |
| Speed | kt, km/h | kt | |
| Theme | Dark, Light, High contrast | Dark | |
| UI scale (native) | multiplier | 1.0 | For kneeboard or dashboard mounts viewed from a distance |
| Country | one of the available countries | | Switches map and data. See [Offline use](./offline-and-data.md) |

## Flying mode

| Setting | Options | Default | Notes |
|---|---|---|---|
| Auto flying mode | Off, Ask, Auto | Ask | See [Flying mode and alerts](./flying-and-alerts.md) |
| Auto zoom | on, off | on | |
| Log split timeout | Per leg, 1, 2, 5, 10, 30 min | 5 min | How long a log stays open after landing. See [Flight logs](./flight-logs.md) |
| Log simulated flights | on, off | off | See [Simulators and devices](./simulators-and-devices.md) |
| Trajectory mode | Time, Distance | Time | Forward ticks on the map and profile |
| Trajectory lookahead | 2, 5, 10 (min or NM) | | |

## Airspace warnings

| Setting | Options | Default |
|---|---|---|
| Horizontal lookahead | 2, 5, 10, 15 min | 5 min |
| Vertical buffer | ft (0 = only warn from climb/descent projection) | 500 ft |

## Alert banners

| Setting | Default |
|---|---|
| Obstacles ahead | on |
| Aerodrome nearby | on |
| Airspace entered / left | on |
| Warning level per airspace category (Alert, Info, Ignore) | See [Flying mode and alerts](./flying-and-alerts.md) |
| Mute airspace warnings on planned course | off |

## Minimum safe altitude

| Setting | Range | Default |
|---|---|---|
| MSA abeam (corridor half-width) | 1 to 10 NM | 5 NM |
| Terrain clearance | 300 to 2,000 ft | 800 ft |
| Obstacle clearance | 300 to 2,000 ft | 1,000 ft |

See [Virtual Radar and vertical profile](./virtual-radar.md).

## Map

| Setting | Notes |
|---|---|
| Airspace ceiling | Default 9,500 ft. See [Map and layers](./map-and-layers.md) |
| Layer visibility | Remembered per layer |
| Terrain colour reference altitude | Default 2,000 ft |
| Traffic vertical filter (web) | 1,000, 2,000, 3,000, 5,000 (default), 10,000 ft or all |
| Home airfield | Set from an aerodrome card |

## Sensors (native)

| Setting | Default | Notes |
|---|---|---|
| Internal barometer | off | See [Simulators and devices](./simulators-and-devices.md) |
| QNH source and QNH | automatic, 1013.25 hPa | |
| Show height above ground | off | Instead of above sea level |
| Show QNH on the pressure altitude gauge | off | |
| Show local time | off | Instead of UTC |
| BlueFly vario auto-connect | none | |

## Data and account

Data versions, offline data and repair: see [Offline use](./offline-and-data.md).
Profile, passkeys, sign out and delete: see [Account and sync](./account-and-sync.md).
