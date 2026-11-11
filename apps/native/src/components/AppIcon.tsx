/**
 * AppIcon — the one place native screens get glyphs from.
 *
 * Tabler icons, the same set the web app uses. Each icon is a deep import
 * (`@tabler/icons-react-native/IconX`): the package barrel re-exports ~6000
 * icons and Metro does no tree-shaking (see types/tabler-icons.d.ts). Add an
 * icon here by name instead of importing Tabler in a screen, so the set in use
 * stays visible in one file.
 */
import React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import IconAlertTriangle from '@tabler/icons-react-native/IconAlertTriangle'
import IconArrowBackUp from '@tabler/icons-react-native/IconArrowBackUp'
import IconArrowDown from '@tabler/icons-react-native/IconArrowDown'
import IconArrowForwardUp from '@tabler/icons-react-native/IconArrowForwardUp'
import IconArrowRight from '@tabler/icons-react-native/IconArrowRight'
import IconArrowsUpDown from '@tabler/icons-react-native/IconArrowsUpDown'
import IconBookmark from '@tabler/icons-react-native/IconBookmark'
import IconBookmarkFilled from '@tabler/icons-react-native/IconBookmarkFilled'
import IconCheck from '@tabler/icons-react-native/IconCheck'
import IconChevronDown from '@tabler/icons-react-native/IconChevronDown'
import IconChevronRight from '@tabler/icons-react-native/IconChevronRight'
import IconChevronUp from '@tabler/icons-react-native/IconChevronUp'
import IconCircle from '@tabler/icons-react-native/IconCircle'
import IconCircleCheck from '@tabler/icons-react-native/IconCircleCheck'
import IconCircleCheckFilled from '@tabler/icons-react-native/IconCircleCheckFilled'
import IconCirclePlus from '@tabler/icons-react-native/IconCirclePlus'
import IconCircleX from '@tabler/icons-react-native/IconCircleX'
import IconCircleXFilled from '@tabler/icons-react-native/IconCircleXFilled'
import IconCloudCheck from '@tabler/icons-react-native/IconCloudCheck'
import IconCloudOff from '@tabler/icons-react-native/IconCloudOff'
import IconCloudUpload from '@tabler/icons-react-native/IconCloudUpload'
import IconCopy from '@tabler/icons-react-native/IconCopy'
import IconCornerDownRight from '@tabler/icons-react-native/IconCornerDownRight'
import IconCurrentLocation from '@tabler/icons-react-native/IconCurrentLocation'
import IconCurrentLocationFilled from '@tabler/icons-react-native/IconCurrentLocationFilled'
import IconDeviceFloppy from '@tabler/icons-react-native/IconDeviceFloppy'
import IconDeviceGamepad2 from '@tabler/icons-react-native/IconDeviceGamepad2'
import IconDots from '@tabler/icons-react-native/IconDots'
import IconDownload from '@tabler/icons-react-native/IconDownload'
import IconEye from '@tabler/icons-react-native/IconEye'
import IconEyeOff from '@tabler/icons-react-native/IconEyeOff'
import IconFolder from '@tabler/icons-react-native/IconFolder'
import IconGitMerge from '@tabler/icons-react-native/IconGitMerge'
import IconHome from '@tabler/icons-react-native/IconHome'
import IconHomeFilled from '@tabler/icons-react-native/IconHomeFilled'
import IconInfoCircle from '@tabler/icons-react-native/IconInfoCircle'
import IconKey from '@tabler/icons-react-native/IconKey'
import IconLink from '@tabler/icons-react-native/IconLink'
import IconList from '@tabler/icons-react-native/IconList'
import IconMap from '@tabler/icons-react-native/IconMap'
import IconMapPin from '@tabler/icons-react-native/IconMapPin'
import IconMinus from '@tabler/icons-react-native/IconMinus'
import IconNavigation from '@tabler/icons-react-native/IconNavigation'
import IconNavigationFilled from '@tabler/icons-react-native/IconNavigationFilled'
import IconNews from '@tabler/icons-react-native/IconNews'
import IconPencil from '@tabler/icons-react-native/IconPencil'
import IconPlane from '@tabler/icons-react-native/IconPlane'
import IconPlaneFilled from '@tabler/icons-react-native/IconPlaneFilled'
import IconPlayerSkipForward from '@tabler/icons-react-native/IconPlayerSkipForward'
import IconPlus from '@tabler/icons-react-native/IconPlus'
import IconRefresh from '@tabler/icons-react-native/IconRefresh'
import IconRoute from '@tabler/icons-react-native/IconRoute'
import IconSearch from '@tabler/icons-react-native/IconSearch'
import IconSettings from '@tabler/icons-react-native/IconSettings'
import IconSettingsFilled from '@tabler/icons-react-native/IconSettingsFilled'
import IconShare from '@tabler/icons-react-native/IconShare'
import IconSparkles from '@tabler/icons-react-native/IconSparkles'
import IconStack2 from '@tabler/icons-react-native/IconStack2'
import IconTrash from '@tabler/icons-react-native/IconTrash'
import IconWifi from '@tabler/icons-react-native/IconWifi'
import IconX from '@tabler/icons-react-native/IconX'

// Names say what the glyph means, not how it looks. "...Filled" is the solid
// variant used for an active/selected state.
const ICONS = {
  add: IconPlus,
  addCircle: IconCirclePlus,
  arrowDown: IconArrowDown,
  arrowRight: IconArrowRight,
  bookmark: IconBookmark,
  bookmarkFilled: IconBookmarkFilled,
  check: IconCheck,
  checkCircle: IconCircleCheck,
  checkCircleFilled: IconCircleCheckFilled,
  chevronDown: IconChevronDown,
  chevronRight: IconChevronRight,
  chevronUp: IconChevronUp,
  circle: IconCircle,
  close: IconX,
  closeCircle: IconCircleX,
  closeCircleFilled: IconCircleXFilled,
  cloudDone: IconCloudCheck,
  cloudOff: IconCloudOff,
  cloudUpload: IconCloudUpload,
  copy: IconCopy,
  download: IconDownload,
  edit: IconPencil,
  eye: IconEye,
  eyeOff: IconEyeOff,
  folder: IconFolder,
  gamepad: IconDeviceGamepad2,
  home: IconHome,
  homeFilled: IconHomeFilled,
  info: IconInfoCircle,
  key: IconKey,
  link: IconLink,
  list: IconList,
  locate: IconCurrentLocation,
  locateFilled: IconCurrentLocationFilled,
  layers: IconStack2,
  map: IconMap,
  merge: IconGitMerge,
  minus: IconMinus,
  more: IconDots,
  navigate: IconNavigation,
  navigateFilled: IconNavigationFilled,
  news: IconNews,
  pin: IconMapPin,
  plane: IconPlane,
  planeFilled: IconPlaneFilled,
  redo: IconArrowForwardUp,
  refresh: IconRefresh,
  route: IconRoute,
  save: IconDeviceFloppy,
  search: IconSearch,
  settings: IconSettings,
  sparkles: IconSparkles,
  settingsFilled: IconSettingsFilled,
  share: IconShare,
  skipForward: IconPlayerSkipForward,
  swapVertical: IconArrowsUpDown,
  trash: IconTrash,
  turnRight: IconCornerDownRight,
  undo: IconArrowBackUp,
  warning: IconAlertTriangle,
  wifi: IconWifi,
} as const

export type AppIconName = keyof typeof ICONS

type Props = {
  name: AppIconName
  size?: number
  color?: string
  /** Applied to a wrapper, e.g. to give the glyph a fixed-width box. */
  style?: StyleProp<ViewStyle>
}

export function AppIcon({ name, size = 18, color, style }: Props) {
  const Glyph = ICONS[name]
  const glyph = <Glyph size={size} color={color} />
  return style ? <View style={[{ alignItems: 'center', justifyContent: 'center' }, style]}>{glyph}</View> : glyph
}
