/**
 * TafTimeline — native port of web's TafTimeline.tsx (hour-by-hour decoded
 * TAF table). RN has no <table>; ported as a horizontally-scrolling row of
 * fixed-width column Views, one per hour slice, with a sticky row-label
 * column on the left (two overlaid ScrollViews: an outer vertical one isn't
 * needed here since AerodromePopup's own ScrollView already handles that —
 * only the hour axis scrolls horizontally).
 */

import { View, Text, ScrollView } from 'react-native'
import Svg, { Path, Circle, Line } from 'react-native-svg'
import { buildTafTimeline, type TafPeriod } from '@open-vfr/shared/parseTaf'
import { sunriseSunset } from '@open-vfr/shared/sunCalc'
import { fmtVis, fmtWind, visTone, ceilingTone, windTone, skyLabel, type TileTone } from '@open-vfr/shared/wxFormat'
import { theme, useScaledTheme, useThemedStyles, type ScaledTheme } from '../styles/theme'

interface Props {
  periods: TafPeriod[] | null
  lat: number
  lng: number
  maxHours?: number
}

function isDaytimeAt(lat: number, lng: number, atMs: number): boolean {
  const { rise, set } = sunriseSunset(lat, lng, new Date(atMs))
  if (!rise || !set) return true
  return atMs >= rise.getTime() && atMs <= set.getTime()
}

type Cover = 'CLR' | 'FEW' | 'SCT' | 'BKN' | 'OVC'

function coverForCeiling(ceilingFt: number | null, hasAnyClouds: boolean): Cover {
  if (ceilingFt == null) return hasAnyClouds ? 'SCT' : 'CLR'
  if (ceilingFt < 1500) return 'OVC'
  return 'BKN'
}

function SkyIcon({ cover, daytime }: { cover: Cover; daytime: boolean }) {
  const showCelestial = cover === 'CLR' || cover === 'FEW' || cover === 'SCT'
  const showCloud = cover !== 'CLR'
  return (
    <Svg viewBox="0 0 24 24" width={26} height={26}>
      {showCelestial && daytime && (
        <>
          <Circle cx={12} cy={10} r={4} fill={theme.accentYellow} stroke={theme.accentYellow} strokeWidth={1.4} />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <Line
              key={a}
              x1={12} y1={10} x2={12} y2={4}
              stroke={theme.accentYellow} strokeWidth={1.4} strokeLinecap="round"
              transform={`rotate(${a} 12 10)`}
            />
          ))}
        </>
      )}
      {showCelestial && !daytime && (
        <Path fill={theme.accentYellow} d="M14 5 A6 6 0 1 0 14 17 A5 5 0 0 1 14 5 Z" />
      )}
      {showCloud && (
        <Path fill={theme.textMuted} d="M6 18 a3.5 3.5 0 0 1 0.3 -6.98 A4.5 4.5 0 0 1 15 10.2 A3.2 3.2 0 0 1 18 18 Z" />
      )}
    </Svg>
  )
}

function fmtColTime(atMs: number): { day: string; time: string } {
  const d = new Date(atMs)
  const day = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:00Z`
  return { day, time }
}

const FR_COLOR: Record<string, { bg: string; fg: string }> = {
  VFR:  { bg: 'rgba(34, 197, 94, 0.18)',  fg: theme.accentGreen },
  MVFR: { bg: 'rgba(59, 130, 246, 0.18)', fg: theme.accentBlue },
  IFR:  { bg: 'rgba(239, 68, 68, 0.18)',  fg: theme.statusDanger },
  LIFR: { bg: 'rgba(168, 85, 247, 0.18)', fg: '#c084fc' },
}

const TONE_COLOR: Record<TileTone, string> = {
  ok: theme.accentGreen, warn: theme.statusWarn, danger: theme.statusDanger, info: theme.textPrimary,
}

const COL_WIDTH = 68

export default function TafTimeline({ periods, lat, lng, maxHours = 24 }: Props) {
  const styles = useThemedStyles(makeStyles)
  const slices = buildTafTimeline(periods, { stepHours: 1, maxSlices: maxHours })
  if (slices.length === 0) return null

  return (
    <ScrollView horizontal style={styles.scrollWrap} showsHorizontalScrollIndicator={false}>
      <View>
        <Row>
          {slices.map((s) => {
            const { day, time } = fmtColTime(s.atMs)
            return (
              <Cell key={s.atMs} bg={theme.surfaceHover}>
                <Text style={styles.timeDay}>{day}</Text>
                <Text style={styles.timeHour}>{time}</Text>
              </Cell>
            )
          })}
        </Row>
        <Row>
          {slices.map((s) => {
            const fr = FR_COLOR[s.flightRule]
            return (
              <Cell key={s.atMs}>
                <View style={[styles.frPill, { backgroundColor: fr.bg }]}>
                  <Text style={[styles.frPillTxt, { color: fr.fg }]}>{s.flightRule}</Text>
                </View>
              </Cell>
            )
          })}
        </Row>
        <Row>
          {slices.map((s) => (
            <Cell key={s.atMs}>
              <SkyIcon cover={coverForCeiling(s.ceilingFt, s.clouds.length > 0)} daytime={isDaytimeAt(lat, lng, s.atMs)} />
              <Text style={styles.skyLabel} numberOfLines={2} adjustsFontSizeToFit>{skyLabel(s.clouds)}</Text>
            </Cell>
          ))}
        </Row>
        <Row>
          {slices.map((s) => (
            <Cell key={s.atMs}>
              <Text style={[styles.cellTxt, { color: TONE_COLOR[visTone(s.visM)] }]}>{fmtVis(s.visM)}</Text>
            </Cell>
          ))}
        </Row>
        <Row>
          {slices.map((s) => (
            <Cell key={s.atMs}>
              <Text style={[styles.cellTxt, { color: TONE_COLOR[ceilingTone(s.ceilingFt)] }]}>
                {s.ceilingFt != null ? `${s.ceilingFt.toLocaleString()} ft` : '—'}
              </Text>
            </Cell>
          ))}
        </Row>
        <Row last>
          {slices.map((s) => (
            <Cell key={s.atMs}>
              {s.wind && !s.wind.calm && !s.wind.variable && s.wind.dirDeg != null && (
                <Svg viewBox="0 0 24 24" width={16} height={16} style={{ transform: [{ rotate: `${s.wind.dirDeg + 180}deg` }] }}>
                  <Path d="M12 2 L18 14 L12 10.5 L6 14 Z" fill={TONE_COLOR[windTone(s.wind)]} />
                </Svg>
              )}
              <Text style={[styles.cellTxt, { color: TONE_COLOR[windTone(s.wind)] }]}>{fmtWind(s.wind)}</Text>
            </Cell>
          ))}
        </Row>
      </View>
    </ScrollView>
  )
}

function Row({ children, last }: { children: React.ReactNode; last?: boolean }) {
  const styles = useThemedStyles(makeStyles)
  return <View style={[styles.row, !last && styles.rowBorder]}>{children}</View>
}

function Cell({ children, bg }: { children: React.ReactNode; bg?: string }) {
  const styles = useThemedStyles(makeStyles)
  return <View style={[styles.cell, bg ? { backgroundColor: bg } : null]}>{children}</View>
}

function makeStyles(theme: ScaledTheme) {
 return {
  scrollWrap: {
    marginTop: theme.space1,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.borderSubtle,
  },
  row: {
    flexDirection: 'row',
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: theme.borderSubtle,
  },
  cell: {
    width: COL_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRightWidth: 1,
    borderRightColor: theme.borderStrong,
  },
  cellTxt: {
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  timeDay: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: theme.textSecondary,
  },
  timeHour: {
    fontSize: 13,
    fontWeight: '800',
    color: theme.textPrimary,
  },
  frPill: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  frPillTxt: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  skyLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: theme.textSecondary,
    textAlign: 'center',
    marginTop: 3,
  },
} as const
}
