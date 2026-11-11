/**
 * "Use your own AI assistant" help: setup steps, the connector address (select
 * to copy, or send it to the assistant app with Share) and example questions.
 * Same texts as the web app (@open-vfr/shared/assistantHelp). Product-neutral.
 */
import React from 'react'
import { Modal, Pressable, ScrollView, Share, Text, TouchableOpacity, View } from 'react-native'
import { ASSISTANT_STEPS, ASSISTANT_DISCLAIMER, assistantExamples, type AssistantHelpTopic } from '@open-vfr/shared/assistantHelp'
import { useThemedStyles, type ScaledTheme } from '../styles/theme'

export function AssistantHelpModal({ visible, topic, mcpUrl, onClose }: { visible: boolean; topic: AssistantHelpTopic; mcpUrl: string; onClose: () => void }) {
  const styles = useThemedStyles(makeStyles)
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>Use your AI assistant</Text>
            <Text style={styles.text}>Ask your own AI assistant about your flight, typed or spoken. It uses the same data and checks as this app.</Text>
            {ASSISTANT_STEPS.map((s, i) => <Text key={s} style={styles.text}>{i + 1}. {s}</Text>)}
            <Text selectable style={styles.url}>{mcpUrl}</Text>
            <TouchableOpacity style={styles.btn} onPress={() => { void Share.share({ message: mcpUrl }) }} accessibilityRole="button">
              <Text style={styles.btnText}>Share address</Text>
            </TouchableOpacity>
            <Text style={styles.label}>Try asking</Text>
            {assistantExamples(topic).map(ex => <Text key={ex} selectable style={styles.example}>{ex}</Text>)}
            <Text style={styles.note}>{ASSISTANT_DISCLAIMER}</Text>
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
    url: { color: theme.textPrimary, fontSize: theme.textSm, padding: theme.space2, borderWidth: 1, borderColor: theme.borderDefault, borderRadius: theme.radiusSm },
    label: { color: theme.textMuted, fontSize: theme.textXs, textTransform: 'uppercase' },
    example: { color: theme.textSecondary, fontSize: theme.textSm, padding: theme.space2, borderWidth: 1, borderColor: theme.borderDefault, borderRadius: theme.radiusSm },
    note: { color: theme.textMuted, fontSize: theme.textXs },
    btn: { alignSelf: 'flex-start', paddingVertical: theme.space2, paddingHorizontal: theme.space3, borderWidth: 1, borderColor: theme.accentBlue, borderRadius: theme.radiusSm },
    btnText: { color: theme.accentBlue, fontSize: theme.textSm },
  } as const
}
