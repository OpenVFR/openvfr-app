// Per-icon deep imports (`@tabler/icons-react-native/IconSearch`). The package's
// barrel re-exports ~6000 icons and Metro does no tree-shaking, so importing
// from the root bundles every icon (and exhausts file handles on Windows).
// The package's subpath exports resolve to .mjs files without adjacent types.
declare module '@tabler/icons-react-native/*' {
  import type { Icon } from '@tabler/icons-react-native'
  const IconComponent: Icon
  export default IconComponent
}
