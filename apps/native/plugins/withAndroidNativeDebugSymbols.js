/**
 * withAndroidNativeDebugSymbols -- include native debug symbols in the release
 * .aab so Google Play (Android vitals) shows symbolicated native crash frames
 * (React Native, Hermes and library code), and the Console stops warning that
 * the bundle has native code without symbols.
 *
 * FULL = function names, files and line numbers (SYMBOL_TABLE = names only).
 * The symbols travel inside the .aab and are stripped from what users download,
 * so install size is unchanged. Libraries that ship already-stripped .so files
 * stay unsymbolicated ("native debug metadata has already been stripped" in the
 * build log). Does not affect the JS layer: Hermes stack frames need the
 * archived source map (see build-android.yml).
 *
 * Appended to the generated android/app/build.gradle (gitignored, regenerated
 * by `expo prebuild`).
 */
const { withAppBuildGradle } = require('@expo/config-plugins')

module.exports = function withAndroidNativeDebugSymbols(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language === 'groovy' && !config.modResults.contents.includes('withAndroidNativeDebugSymbols')) {
      config.modResults.contents += `
// Injected by withAndroidNativeDebugSymbols.js -- see that file for why.
android {
    buildTypes {
        release {
            ndk {
                debugSymbolLevel 'FULL'
            }
        }
    }
}
`
    }
    return config
  })
}
