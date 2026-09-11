/**
 * withAndroidLargeHeap — Expo config plugin that sets android:largeHeap="true"
 * on the <application> element in the generated AndroidManifest.xml.
 *
 * Not exposed as a plain app.json android.* property by Expo -- requires a
 * custom config plugin using withAndroidManifest. See
 * https://docs.expo.dev/versions/latest/config/app/ (android.* options) and
 * https://docs.expo.dev/config-plugins/introduction/.
 *
 * Why: this app loads several large simultaneous map layers (obstacles,
 * aeroways, landuse, hillshade/contours raster-dem tiles, multiple
 * aviation GeoJSON sources) on top of React Native/Hermes + MapLibre
 * Native's own native heap usage. The default Android per-process heap
 * growth limit (256MB on most devices, larger only with largeHeap) was
 * observed causing a real OutOfMemoryError crash on a physical device
 * during normal map use (verified via `adb logcat`: "Failed to allocate
 * ... giving up on allocation because <1% of heap free after GC ...
 * target footprint 268435456" -- i.e. the 256MB default limit).
 * largeHeap requests a larger limit from the OS (device/manufacturer
 * dependent, commonly 512MB-1GB+) -- doesn't eliminate memory pressure
 * outright, but gives real headroom for this app's actual working set
 * instead of crashing at the default ceiling.
 */
const { withAndroidManifest } = require('@expo/config-plugins')

module.exports = function withAndroidLargeHeap(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0]
    if (application) {
      application.$['android:largeHeap'] = 'true'
    }
    return config
  })
}
