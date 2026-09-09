const path = require('path')
const fs = require('fs')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

config.resolver.assetExts.push('geojson')

// ---------------------------------------------------------------------------
// @open-vfr/shared — shared utilities package (packages/shared/src/)
//
// Metro resolves @open-vfr/shared/<name> directly to
// packages/shared/src/<name>.ts so:
//   - No pnpm install needed in native/ for shared code changes
//   - Metro watches the folder → hot reload works across the package boundary
//   - No symlinks (Windows-safe)
//
// A custom resolveRequest is used (rather than plain extraNodeModules)
// because Metro (bundled with Expo SDK 57+) no longer auto-appends source
// extensions (.ts) when substituting an extraNodeModules-mapped path for a
// package-prefixed subpath import — it now requires an exact file match.
// Resolving to the exact .ts file here sidesteps that ambiguity entirely.
//
// NOTE: this fixes the live Metro dev server (`expo start`, `expo run:android`
// — the normal dev workflow, confirmed working). The one-shot static bundler
// (`expo export` / `expo export:embed`, only used by the `build:apk:prod`
// release script) still fails with "Failed to get the SHA-1 for: ..." for
// files under packages/shared/src — an unresolved Metro/Expo SDK 57 crawler
// regression for source outside native/. See docs/todo.md.
// ---------------------------------------------------------------------------
const sharedRoot = path.resolve(config.projectRoot, '../../packages/shared')
const sharedSrc = path.resolve(sharedRoot, 'src')

const packagesRoot = path.resolve(config.projectRoot, '../../packages')
config.watchFolders = [...(config.watchFolders ?? []), packagesRoot]

const SHARED_SOURCE_EXTS = ['ts', 'tsx', 'js', 'jsx']

const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('@open-vfr/shared/')) {
    const subpath = moduleName.slice('@open-vfr/shared/'.length)
    const base = path.join(sharedSrc, subpath)
    const ext = SHARED_SOURCE_EXTS.find((e) => fs.existsSync(`${base}.${e}`))
    if (!ext) {
      throw new Error(`[metro.config.js] Cannot find @open-vfr/shared source file for "${moduleName}" (looked for ${base}.{${SHARED_SOURCE_EXTS.join(',')}})`)
    }
    return { type: 'sourceFile', filePath: `${base}.${ext}` }
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform)
}

// When Metro resolves imports from packages/shared/src/, it won't find
// node_modules there. Point it at native/node_modules as the fallback.
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
]

module.exports = config
