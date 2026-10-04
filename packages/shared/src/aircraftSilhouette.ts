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
 * -x/left, roughly -22..20 x / -10..8 y) so callers can translate/rotate
 * (pitch tilt) the whole marker the same way regardless of which set is
 * returned.
 */

import type { AircraftCategory } from './types'

export interface SilhouettePart {
  d: string
  opacity: number
  /** Fill colour; callers default to white. Used for canopies/wheels so the
   *  marker reads as an aircraft rather than a flat blob. */
  fill?: string
}

// Frame: nose +x, tail -x, y down. Roughly -20..20 x, -10..8 y.

// High-wing single/twin (side view): cabin with sloped windscreen and side
// window, wing on the roof, swept fin, tailplane, prop disc, tricycle gear.
const FIXED_WING: SilhouettePart[] = [
  { d: 'M19,0.2 L18.5,-1.8 L15,-2.6 L9,-3 L6,-5 L-3,-5 L-7,-3 L-19,-1.6 L-19.5,-0.2 L-8,1.6 L-4,2.8 L12,2.8 L16,2.2Z', opacity: 0.97 },
  { d: 'M-9,-2.8 L-16.5,-8.2 L-19.5,-8.2 L-19.5,-1.6 L-12,-1.8Z', opacity: 0.95 },
  { d: 'M-12,-0.5 L-21,-0.5 L-21,0.6 L-12,0.6Z', opacity: 0.85 },
  { d: 'M9.5,-5 C6,-6.8 -4,-6.8 -8,-5 C-4,-4.2 6,-4.2 9.5,-5Z', opacity: 0.97 },
  { d: 'M8.6,-2.8 L5.8,-4.6 L2,-4.6 L2,-2.8Z', opacity: 0.9, fill: '#0f172a' },
  { d: 'M1,-2.8 L1,-4.6 L-2.6,-4.6 L-5.6,-2.8Z', opacity: 0.9, fill: '#0f172a' },
  { d: 'M18.6,-1.7 L20.6,-0.5 L20.6,0.9 L18.6,1.9Z', opacity: 0.97 },
  { d: 'M19.8,-5.2 L21,-5.2 L21,5.4 L19.8,5.4Z', opacity: 0.7 },
  { d: 'M-1.6,2.8 L-0.4,2.8 L-0.8,5.6 L-1.8,5.6Z', opacity: 0.9 },
  { d: 'M-2.4,6.2 a1.2,1.2 0 1,0 2.4,0 a1.2,1.2 0 1,0 -2.4,0Z', opacity: 0.95, fill: '#cbd5e1' },
  { d: 'M11.4,2.6 L12.4,2.6 L12.2,5.2 L11.4,5.2Z', opacity: 0.9 },
  { d: 'M10.9,6 a1.1,1.1 0 1,0 2.2,0 a1.1,1.1 0 1,0 -2.2,0Z', opacity: 0.95, fill: '#cbd5e1' },
]

// Glider / motor glider: long slender fuselage, bubble canopy, T-tail,
// foreshortened long wing, single main wheel.
const GLIDER: SilhouettePart[] = [
  { d: 'M20,0.6 C16,-1.6 8,-2.2 0,-1.8 L-14,-0.7 L-21,-0.4 L-21,0.5 L-14,0.9 C-4,1.6 10,1.8 20,0.6Z', opacity: 0.97 },
  { d: 'M10,-1.9 C8,-4.6 2,-4.6 -3,-1.7Z', opacity: 0.9, fill: '#0f172a' },
  { d: 'M-15,-0.8 L-21,-0.6 L-22,-6.5 L-18.5,-6.5Z', opacity: 0.92 },
  { d: 'M-22.5,-6.9 L-17,-6.9 L-17,-5.9 L-22.5,-5.9Z', opacity: 0.88 },
  { d: 'M5,0.9 L-4,0.9 L-10,7.5 L-5.5,7.5Z', opacity: 0.93 },
  { d: 'M1.8,2.8 a1.2,1.2 0 1,0 2.4,0 a1.2,1.2 0 1,0 -2.4,0Z', opacity: 0.95, fill: '#cbd5e1' },
]

// Helicopter: chin-bubble cabin with windscreen, tail boom + fin + tail rotor,
// mast, main rotor disc, skids.
const HELICOPTER: SilhouettePart[] = [
  { d: 'M12,1.2 C11.6,-2.8 6,-4.6 -2,-4 C-6,-3.6 -7,-1 -7,1 C-7,3 -3,3.6 2,3.6 C8,3.6 11.6,3.2 12,1.2Z', opacity: 0.97 },
  { d: 'M11,0.6 C10.4,-2.4 7.6,-3.6 4.4,-3.7 L4.4,0.6Z', opacity: 0.9, fill: '#0f172a' },
  { d: 'M-6,-2.4 L-18.5,-1.4 L-18.5,-0.2 L-6,0.8Z', opacity: 0.92 },
  { d: 'M-16,-1.3 L-19.5,-5.8 L-18,-5.8 L-15.4,-1.2Z', opacity: 0.9 },
  { d: 'M-19.4,-4.6 L-18.6,-4.6 L-18.6,1 L-19.4,1Z', opacity: 0.6 },
  { d: 'M-0.6,-4 L0.6,-4 L0.6,-7 L-0.6,-7Z', opacity: 0.95 },
  { d: 'M-20,-7.9 L-1,-7.5 L19,-7.9 L19,-7.1 L1,-6.8 L-20,-7.1Z', opacity: 0.8 },
  { d: 'M9,6.2 L-9,6.2 L-9,7 L9,7Z', opacity: 0.95 },
  { d: 'M3.6,3.4 L4.6,3.4 L4.6,6.2 L3.6,6.2Z', opacity: 0.9 },
  { d: 'M-4.6,3.4 L-3.6,3.4 L-3.6,6.2 L-4.6,6.2Z', opacity: 0.9 },
]

// Gyroplane / autogyro: open pod with pilot's head, windscreen, tall aft-leaning
// mast carrying an unpowered rotor (tilted nose-up), rear pusher engine and
// propeller, boom with fin and rudder, nose wheel + main wheels.
const GYROCOPTER: SilhouettePart[] = [
  { d: 'M11,2.4 C10,-0.8 5,-1.8 -2,-1.6 L-7,-1 L-8,2.6 L-3,3.6 C3,3.8 9,3.8 11,2.4Z', opacity: 0.97 },
  { d: 'M-2.7,-3.2 a1.7,1.7 0 1,0 3.4,0 a1.7,1.7 0 1,0 -3.4,0Z', opacity: 0.95 },
  { d: 'M8.4,1.6 L5.6,-1.4 L4.6,-1.4 L6.8,1.8Z', opacity: 0.9, fill: '#0f172a' },
  { d: 'M-2,-1.6 L-0.6,-1.6 L-3.4,-8 L-4.8,-8Z', opacity: 0.95 },
  { d: 'M13,-9.4 L-15,-7.6 L-15,-6.8 L13,-8.6Z', opacity: 0.85 },
  { d: 'M-7,0 L-11.5,-0.4 L-11.5,2.2 L-7,2.6Z', opacity: 0.92 },
  { d: 'M-12.8,-5.5 L-11.9,-5.5 L-11.9,5.5 L-12.8,5.5Z', opacity: 0.6 },
  { d: 'M-3,2.6 L-17,2.2 L-17,3.1 L-3,3.6Z', opacity: 0.9 },
  { d: 'M-14.6,-4.6 L-18,-4.6 L-17.6,2.6 L-14.8,2.4Z', opacity: 0.92 },
  { d: 'M7.6,3.2 L8.6,3.2 L9,5.3 L8,5.3Z', opacity: 0.9 },
  { d: 'M7.1,6.5 a1.5,1.5 0 1,0 3,0 a1.5,1.5 0 1,0 -3,0Z', opacity: 0.95, fill: '#cbd5e1' },
  { d: 'M-4.2,3.4 L-3.2,3.4 L-3.2,5.4 L-4.2,5.4Z', opacity: 0.9 },
  { d: 'M-5.2,6.5 a1.5,1.5 0 1,0 3,0 a1.5,1.5 0 1,0 -3,0Z', opacity: 0.95, fill: '#cbd5e1' },
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
