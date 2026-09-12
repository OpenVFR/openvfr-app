/**
 * aircraftSilhouette — the live-position aircraft marker in both
 * VerticalProfile.tsx (native) and VirtualRadar.tsx (web) used to render the
 * exact same fixed single-engine-airplane side-view shape regardless of the
 * selected aircraft's actual category. AircraftProfileDocType.category
 * (SEP|MEP|MICRO|GYRO|HELI|TMG|GLIDER) already exists and was unused for
 * this — this module returns a small set of schematic side-view path parts
 * keyed off that one field, shared so both platforms draw identically.
 *
 * Deliberately schematic, not a true per-registration geometric model (the
 * app has no wingspan/high-low-wing data at all — see docs/todo.md's
 * separate, larger "true per-registration aircraft side-view model" item).
 * At the ~16-20px size this marker renders at, the goal is just "readably a
 * different silhouette family", not aerodynamic accuracy:
 *   - FIXED_WING:  SEP, MEP, MICRO (twin vs single is invisible at this
 *     size, and MICRO airframes vary too much to warrant their own shape —
 *     grouped rather than inventing a barely-distinguishable variant)
 *   - GLIDER:      GLIDER, TMG (a motor glider looks like a glider from
 *     outside — long slender wing, slender fuselage, small tail)
 *   - HELICOPTER:  HELI — pod + tail boom + tail rotor + main rotor disc line
 *   - GYROCOPTER:  GYRO — pod + short tail boom + pusher prop (no tail
 *     rotor — autogyros don't have one) + rotor disc line
 *
 * All four sets share one local coordinate frame (nose at +x/right, tail at
 * -x/left, roughly -14..14 x / -8..13 y) so callers can translate/rotate
 * (pitch tilt) the whole marker the same way regardless of which set is
 * returned.
 */

import type { AircraftCategory } from './types'

export interface SilhouettePart {
  d: string
  opacity: number
}

const FIXED_WING: SilhouettePart[] = [
  { d: 'M12,0 C8,-2 0,-2.5 -8,-1.5 L-12,-0.5 L-12,1 L-8,2 C0,2.5 8,2 12,0Z', opacity: 0.97 },
  { d: 'M0,2 L5,2 L9,10 L7,10Z', opacity: 0.95 },
  { d: 'M-10,-1.5 L-8,-1.5 L-7,-7 L-9,-7 L-12,-0.5Z', opacity: 0.9 },
  { d: 'M-12,0.5 L-9,1.5 L-8,5 L-10,5Z', opacity: 0.85 },
]

const GLIDER: SilhouettePart[] = [
  { d: 'M13,0 C9,-1.2 0,-1.6 -9,-1 L-13,-0.4 L-13,0.6 L-9,1.2 C0,1.6 9,1.2 13,0Z', opacity: 0.97 },
  { d: 'M0,1.2 L2,1.2 L11,13 L9,13Z', opacity: 0.95 },
  { d: 'M-11,-1 L-9.5,-1 L-8.5,-6 L-10,-6 L-13,-0.4Z', opacity: 0.9 },
  { d: 'M-13,0.3 L-10,1 L-9,4 L-11,4Z', opacity: 0.85 },
]

const HELICOPTER: SilhouettePart[] = [
  { d: 'M6,0 C4,-2.2 -2,-2.6 -7,-1.6 C-9,-1.2 -9,1.2 -7,1.6 C-2,2.6 4,2.2 6,0Z', opacity: 0.97 },
  { d: 'M-6,-0.3 L-13,-0.3 L-13,0.3 L-6,0.3Z', opacity: 0.9 },
  { d: 'M-13.3,-2.2 L-12.7,-2.2 L-12.7,2.2 L-13.3,2.2Z', opacity: 0.85 },
  { d: 'M-14,-0.15 L14,-0.15 L14,0.15 L-14,0.15Z', opacity: 0.8 },
]

const GYROCOPTER: SilhouettePart[] = [
  { d: 'M5,0 C3,-2 -2,-2.4 -6,-1.4 C-7.6,-1 -7.6,1 -6,1.4 C-2,2.4 3,2 5,0Z', opacity: 0.97 },
  { d: 'M-6,-0.25 L-11,-0.25 L-11,0.25 L-6,0.25Z', opacity: 0.9 },
  { d: 'M-11.3,-2 L-10.7,-2 L-10.7,2 L-11.3,2Z', opacity: 0.85 },
  { d: 'M-12,-0.15 L12,-0.15 L12,0.15 L-12,0.15Z', opacity: 0.8 },
]

export function getAircraftSilhouette(category?: AircraftCategory | string | null): SilhouettePart[] {
  switch (category) {
    case 'HELI':   return HELICOPTER
    case 'GYRO':   return GYROCOPTER
    case 'GLIDER':
    case 'TMG':    return GLIDER
    default:       return FIXED_WING
  }
}
