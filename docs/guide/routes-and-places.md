---
title: Saved routes and places
description: Save, load, import and export routes, and keep your own places in folders.
sidebar:
  order: 6
---

## The working route

The route on the map is your working route. It is kept on your device and
restored when you reopen the app, even if you never save it.

Route actions (the **⋯** menu in the planning panel):

- **Find a destination** (web menu; on native from the map tools; see [Aerodromes and briefing](./aerodromes-and-briefing.md)).
- **Reverse** the route.
- **Export** as GPX (web also KML).
- **Import** a GPX file.
- **Close route** takes it off the map. A saved route stays in Saved
  routes, and you are asked first if there are unsaved changes.

Other editing tools: type the whole route as text (web, for example
`ESOS ESGG ESSA`), undo and redo (Ctrl+Z and Ctrl+Shift+Z on the web), and
reorder waypoints by dragging them in the route table.

## Saved routes

The route library lists routes you have saved. For each you can load,
rename and delete (with confirmation).

- **Save** updates the saved route the working route came from.
- **Save as** always creates a new route, even if the name matches an
  existing one, so you never overwrite by accident.
- A new route you have not saved yet is saved under a suggested name that
  you can change.
- A route remembers its legs' own levels, speeds and winds, and the
  aircraft you chose.
- If the working route has unsaved changes, loading another route asks
  first.

Saved routes sync between your devices when you are signed in. If the
server refuses a route for good (for example it is too large, or you have
reached an account limit), the route stays on this device and a note
explains why.

## Places

Places are your own named points: a farm strip, a landmark, a turning
point. Open **Places** to:

- Add a place by typing a name and picking its position (click the map to
  pick coordinates).
- Put places in **folders**.
- **Edit** a name or folder (double-click to edit in the web app).
- **Show** a place on the map, **add** it to the route, or **insert** it
  into the route at a chosen position.
- **Export** all places as GPX, or **import** places from a GPX file.

Places also appear on the map as their own layer, and in search.

### Dropped in Flight

While flying, **Drop point** saves your current position as a place in the
folder **Dropped in Flight**. Use it to mark something you passed over, or
a field you want to remember.

## Route legs and editing in flight

On the ground, you can drag any waypoint and any leg midpoint to reshape
the route (undo is always there). In flight, editing is locked so that a
knock on a touch screen cannot move a leg. Tap a leg to unlock it for a few
seconds, and any route change locks it again.
