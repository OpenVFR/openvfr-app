/**
 * NOTAM text with tappable coordinates: every coordinate the shared scanner
 * finds is a nested <Text> that marks its point on the map (see
 * @open-vfr/shared/notamCoordinateFocus; AviationMap draws the marker).
 * Renders as children, so it goes inside the <Text> that shows NOTAM text and
 * inherits its style.
 */
import React, { useMemo } from 'react'
import { StyleSheet, Text } from 'react-native'
import { splitNotamTextCoordinates } from '@open-vfr/shared/notamTextSegments'
import { focusNotamCoordinate } from '@open-vfr/shared/notamCoordinateFocus'

export default function NotamBody({ text }: { text: string }) {
  const segments = useMemo(() => splitNotamTextCoordinates(text), [text])
  return (
    <>
      {segments.map((s, i) => s.kind === 'text'
        ? <Text key={i}>{s.text}</Text>
        : (
          <Text
            key={i}
            style={styles.coord}
            accessibilityRole="button"
            accessibilityLabel="Show this point on the map"
            onPress={() => focusNotamCoordinate({ lat: s.lat, lng: s.lng })}
          >{s.text}</Text>
        ))}
    </>
  )
}

const styles = StyleSheet.create({
  // Same light blue as the map's other tappable text.
  coord: { color: '#7dd3fc', textDecorationLine: 'underline' },
})
