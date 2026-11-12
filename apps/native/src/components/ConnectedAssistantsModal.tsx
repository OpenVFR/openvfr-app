/**
 * The AI assistants this account has connected, each with Disconnect (the same list as the web app's account
 * panel). Disconnecting removes the consent and the assistant's tokens: its next use needs sign-in and approval
 * again. Opened from Settings, shown only where the server offers the assistant connection.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { listAssistantConsents, revokeAssistantConsent, type AssistantConsent } from '../utils/assistantConnections'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'

const what = (scopes: string[]) =>
  [scopes.includes('routes:read') ? 'Briefings, saved routes, places and aircraft' : 'Briefings only', scopes.includes('logs:read') && 'flight summaries']
    .filter(Boolean).join(', ')

export function ConnectedAssistantsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const styles = useThemedStyles(makeStyles)
  const [rows, setRows] = useState<AssistantConsent[] | null>(null)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setError('')
    try { setRows(await listAssistantConsents()) } catch (e) { setError(e instanceof Error ? e.message : 'Could not load connected assistants'); setRows([]) }
  }, [])
  useEffect(() => { if (visible) { setRows(null); void load() } }, [visible, load])

  function disconnect(r: AssistantConsent) {
    Alert.alert(`Disconnect ${r.name}?`, 'It will need your sign-in and approval to connect again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect', style: 'destructive',
        onPress: () => {
          setBusyId(r.id); setError('')
          revokeAssistantConsent(r.id).then(load).catch(e => setError(e instanceof Error ? e.message : 'Could not disconnect')).finally(() => setBusyId(''))
        },
      },
    ])
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>Connected AI assistants</Text>
            {!!error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
            {rows === null ? (
              <ActivityIndicator />
            ) : rows.length === 0 ? (
              error ? null : <Text style={styles.text}>No assistant connected.</Text>
            ) : rows.map(r => (
              <View key={r.id} style={styles.item}>
                <View style={styles.itemText}>
                  <Text style={styles.name}>{r.name}</Text>
                  <Text style={styles.text}>{what(r.scopes)}{r.createdAt ? ` · since ${new Date(r.createdAt).toLocaleDateString('sv-SE')}` : ''}</Text>
                </View>
                <TouchableOpacity style={styles.btnDanger} disabled={busyId === r.id} onPress={() => disconnect(r)} accessibilityRole="button" accessibilityLabel={`Disconnect ${r.name}`}>
                  <Text style={styles.btnDangerText}>{busyId === r.id ? '…' : 'Disconnect'}</Text>
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity style={styles.btn} onPress={onClose} accessibilityRole="button"><Text style={styles.btnText}>Close</Text></TouchableOpacity>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function makeStyles(theme: ScaledTheme) {
  return {
    backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)', padding: theme.space4 },
    card: { width: '100%', maxWidth: 440, maxHeight: '90%', backgroundColor: theme.surfaceSheet, borderRadius: theme.radiusMd, borderWidth: 1, borderColor: theme.borderDefault },
    content: { padding: theme.space4, gap: theme.space3 },
    title: { color: theme.textPrimary, fontSize: theme.textLg, fontWeight: '600' },
    text: { color: theme.textSecondary, fontSize: theme.textSm, lineHeight: theme.textSm * 1.45 },
    error: { color: theme.statusDanger, fontSize: theme.textSm },
    item: { flexDirection: 'row', alignItems: 'center', gap: theme.space3, padding: theme.space2, borderWidth: 1, borderColor: theme.borderDefault, borderRadius: theme.radiusSm },
    itemText: { flex: 1, gap: 2 },
    name: { color: theme.textPrimary, fontSize: theme.textSm, fontWeight: '600' },
    btn: { alignSelf: 'flex-start', paddingVertical: theme.space2, paddingHorizontal: theme.space3, borderWidth: 1, borderColor: theme.accentBlue, borderRadius: theme.radiusSm },
    btnText: { color: theme.accentBlue, fontSize: theme.textSm },
    btnDanger: { paddingVertical: theme.space2, paddingHorizontal: theme.space3, borderWidth: 1, borderColor: theme.statusDanger, borderRadius: theme.radiusSm },
    btnDangerText: { color: theme.statusDanger, fontSize: theme.textSm },
  } as const
}
