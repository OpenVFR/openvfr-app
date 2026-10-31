/**
 * Full-screen "Update required" page, rendered instead of the whole app while
 * this build is below the server's minimum (hooks/useForceUpdate.ts, App.tsx).
 * It cannot be dismissed: the only way on is the update.
 *
 * Rendered without the settings / safe-area providers, so it uses the static
 * theme tokens and plain padding.
 */
import React, { useState } from 'react'
import { ActivityIndicator, BackHandler, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Application from 'expo-application'
import { theme } from '../styles/theme'

export function UpdateRequired({ onUpdate }: { onUpdate: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  // Android back button: leave the app, never fall through to the screen underneath.
  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { BackHandler.exitApp(); return true })
    return () => sub.remove()
  }, [])

  const press = async () => {
    setBusy(true); setFailed(false)
    try { setFailed(!(await onUpdate())) } finally { setBusy(false) }
  }

  const store = Platform.OS === 'ios' ? 'the App Store' : 'Google Play'
  const build = Application.nativeBuildVersion
  return (
    <View style={styles.root} accessibilityViewIsModal>
      <View style={styles.card}>
        <Text style={styles.title} accessibilityRole="header">Update required</Text>
        <Text style={styles.body}>
          This version of OpenVFR no longer works with the server. Install the latest version from {store} to continue.
        </Text>
        <Pressable style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]} onPress={press} disabled={busy}
          accessibilityRole="button" accessibilityLabel="Update OpenVFR">
          {busy ? <ActivityIndicator color="#0a0e16" /> : <Text style={styles.buttonText}>Update</Text>}
        </Pressable>
        {failed && (
          <Text style={styles.note}>Could not open {store}. Open it yourself and update OpenVFR there.</Text>
        )}
        <Text style={styles.meta}>
          Installed: {Application.nativeApplicationVersion ?? '?'}{build ? ` (build ${build})` : ''}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0e16',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: { width: '100%', maxWidth: 420, gap: 16 },
  title: { color: theme.textPrimary, fontSize: 24, fontWeight: '700' },
  body: { color: theme.textSecondary, fontSize: 16, lineHeight: 23 },
  button: {
    backgroundColor: theme.accentBlue,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: '#0a0e16', fontSize: 17, fontWeight: '700' },
  note: { color: theme.textSecondary, fontSize: 14 },
  meta: { color: theme.textSecondary, fontSize: 12, opacity: 0.7, marginTop: 8 },
})
