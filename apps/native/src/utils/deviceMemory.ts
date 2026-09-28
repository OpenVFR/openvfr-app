/**
 * Device-memory tier gate for optional heavy map layers.
 *
 * Background: AviationMap.tsx's landuse/hillshade/contours PMTiles sources
 * are sticky-mounted (MapLibre Native throws "id cannot be changed" if a
 * source is unmounted then re-added -- see that file's readyStage comment)
 * and cost ~87MB / ~231MB / ~117MB respectively once turned on for the rest
 * of the session. hillshade/contours visibility is persisted to
 * AsyncStorage, so a pilot who has ever enabled them gets them back on at
 * the very next cold restart -- the highest-risk moment, when auth/session
 * restore, route/aircraft sync, and weather/NOTAM fetches are all also
 * competing for memory. A real OutOfMemoryError from this combination was
 * already caught on a Samsung SM_S918B (see AviationMap.tsx's readyStage
 * doc comment) even with staggered mount timing.
 *
 * This is the standard mobile mitigation for that shape of problem --
 * adaptive feature/quality gating by device RAM tier, the same technique
 * games and other asset-heavy apps use to keep optional high-cost features
 * off constrained hardware -- applied here the same way `satelliteLocked`
 * (MapScreen.tsx) already gates the satellite basemap by flight mode.
 *
 * Threshold: 4 GiB total device RAM. Chosen with headroom, not as a tight
 * fit: landuse+hillshade+contours together are ~435MB of PMTiles source,
 * and the OOM investigation's own heap dumps (apps/native/.scratch/
 * oom-investigation.md) saw total process PSS reach ~1.8GB during ordinary
 * heavy navigation on a high-RAM device even without the Range-response bug
 * in play -- purely from decoded tile/texture working set. A device with
 * only 3-4GB total RAM shared across the whole OS has far less margin
 * before the same working set trips the system-wide low-memory killer,
 * not just this app's own heap ceiling.
 */
import * as Device from 'expo-device'

const LOW_MEMORY_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024 // 4 GiB

/**
 * True when the optional heavy terrain layers (hillshade, contours) should
 * be locked off regardless of the pilot's persisted preference. `null`
 * total memory (some devices/OSes don't report it) is treated as
 * "not low-memory" -- fail open, since the far more common failure mode in
 * practice was the persisted-preference startup race, not total device RAM.
 */
export function isLowMemoryDevice(): boolean {
  // expo-device requires a native rebuild (not just a JS bundle reload) to
  // pick up -- fail open (not locked) rather than throw/crash if a dev
  // client is running ahead of that rebuild, same fail-open reasoning as
  // the null-totalMemory case below.
  try {
    const totalMemory = Device.totalMemory
    if (totalMemory == null || totalMemory <= 0) return false
    return totalMemory < LOW_MEMORY_THRESHOLD_BYTES
  } catch {
    return false
  }
}
