/**
 * FollowCountdown — seconds left until a panned map returns to the aircraft.
 * Shown as a small badge on the locate button so the pilot knows the lock is
 * not lost. The deadline arrives through a ValueStore: panning re-arms it many
 * times a second, and only this badge may re-render for that.
 */
import React, { useEffect, useState } from 'react'
import { Text } from 'react-native'
import { followCountdownSecs } from '@open-vfr/shared/followZoom'
import { useStoreValue, type ValueStore } from '../utils/valueStore'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'

export function FollowCountdown({ returnAtStore }: { returnAtStore: ValueStore<number | null> }) {
  const styles = useThemedStyles(makeStyles)
  const returnAt = useStoreValue(returnAtStore)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (returnAt == null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [returnAt])
  const secs = followCountdownSecs(returnAt, now)
  if (secs == null) return null
  return <Text style={styles.badge} pointerEvents="none" testID="follow-countdown">{secs}</Text>
}

function makeStyles(t: ScaledTheme) {
  return {
    badge: {
      position: 'absolute' as const, right: 3, bottom: 1,
      fontSize: 10, fontWeight: '800' as const, color: t.accentBlue,
    },
  }
}
