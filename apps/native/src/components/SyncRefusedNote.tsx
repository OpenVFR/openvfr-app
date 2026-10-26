/**
 * Note on a list row the server refused for good (too large, account limit):
 * the row exists on this device only. A tap explains it, with the server's
 * answer for support.
 */
import React from 'react'
import { Text, Alert, StyleSheet } from 'react-native'
import { rejectionText, type RejectedRow } from '@open-vfr/shared/cloudSync'
import { theme } from '../styles/theme'

export function SyncRefusedNote({ row }: { row: RejectedRow | undefined }) {
  if (!row) return null
  return (
    <Text
      style={styles.note}
      onPress={() => Alert.alert(
        rejectionText(row.reason),
        `This item is kept on this device only: the server refused it, so it is not in your account and not on your other devices. Make it smaller or remove something to free space, then save it again.\n\nServer: ${row.detail}`,
      )}
      accessibilityRole="button"
    >
      ⚠ {rejectionText(row.reason)}
    </Text>
  )
}

const styles = StyleSheet.create({
  note: {
    color:      theme.statusDanger,
    fontSize:   11,
    fontWeight: '600',
    marginTop:  2,
  },
})
