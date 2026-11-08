/**
 * TextInput with an inline clear button once there is text. Android has no
 * built-in clear button (iOS's `clearButtonMode` is not used so both platforms
 * look the same). Pass the same `style` you would give a TextInput.
 */
import React from 'react'
import { View, TextInput, TouchableOpacity, StyleSheet, type TextInputProps } from 'react-native'
import { AppIcon } from './AppIcon'
import { theme } from '../styles/theme'

export function ClearableTextInput({ value, onChangeText, style, ...rest }: TextInputProps) {
  return (
    <View>
      <TextInput {...rest} value={value} onChangeText={onChangeText} style={[style, styles.padRight]} />
      {!!value && (
        <TouchableOpacity
          style={styles.clear}
          onPress={() => onChangeText?.('')}
          accessibilityRole="button"
          accessibilityLabel="Clear"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <AppIcon name="closeCircleFilled" size={18} color={theme.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  padRight: { paddingRight: 36 },
  clear: { position: 'absolute', right: 10, top: 0, bottom: 0, justifyContent: 'center' },
})
