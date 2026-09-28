/**
 * TEMPORARY -- native-sheet risk spike, not part of the app's real flows.
 *
 * Exercises the specific risks identified before committing to migrating
 * the 13 custom Modal-based popups to @expo/ui's BottomSheet: a scrolling
 * list competing with the sheet's own drag gesture, a virtualised FlatList
 * (must have a bounded height), a text field with the keyboard open, and a
 * slider dragged inside a sheet that itself drags vertically.
 *
 * Reached from a temporary button at the bottom of Settings. Delete this
 * file, the FlatList import if unused elsewhere, and the Settings button
 * once the real migration decision is made either way.
 */
import React from 'react'
import { View, Text, TextInput, FlatList, ScrollView, StyleSheet, Platform } from 'react-native'
import Slider from '@react-native-community/slider'
import { Host, BottomSheet, Button as UiButton, RNHostView } from '@expo/ui'

const LIST_ITEMS = Array.from({ length: 60 }, (_, i) => `Row ${i + 1}`)

export function SheetRiskTestScreen({ onClose }: { onClose: () => void }) {
  const [openScroll, setOpenScroll]   = React.useState(false)
  const [openList, setOpenList]       = React.useState(false)
  const [openKeyboard, setOpenKeyboard] = React.useState(false)
  const [openSlider, setOpenSlider]   = React.useState(false)
  const [text, setText]               = React.useState('')
  const [sliderVal, setSliderVal]     = React.useState(50)

  return (
    <View style={s.root}>
      <Text style={s.title}>Native sheet risk test</Text>
      <Text style={s.sub}>Platform: {Platform.OS} {Platform.Version}</Text>
      <Btn label="\u2715 Close" onPress={onClose} />

      <Btn label="1. ScrollView content" onPress={() => setOpenScroll(true)} />
      <Btn label="2. Virtualised FlatList (60 rows)" onPress={() => setOpenList(true)} />
      <Btn label="3. Text field + keyboard" onPress={() => setOpenKeyboard(true)} />
      <Btn label="4. Slider drag" onPress={() => setOpenSlider(true)} />

      {/* -------------------------------------------------------------- */}
      <BottomSheet isPresented={openScroll} onDismiss={() => setOpenScroll(false)}>
        <RNHostView style={{ height: 400 }}>
          <ScrollView nestedScrollEnabled style={s.sheetInner} testID="risk-scroll">
            <Text style={s.sheetTitle}>Scroll test</Text>
            <Text style={s.sheetNote}>
              Swipe UP inside this list from a point that starts on text (not the
              handle). Expected: the list scrolls. Risk: the whole sheet drags
              closed/expands instead.
            </Text>
            {LIST_ITEMS.map(t => <Text key={t} style={s.row}>{t}</Text>)}
          </ScrollView>
        </RNHostView>
      </BottomSheet>

      {/* -------------------------------------------------------------- */}
      <BottomSheet isPresented={openList} onDismiss={() => setOpenList(false)}>
        <RNHostView style={{ height: 500 }}>
          <FlatList
            testID="risk-flatlist"
            style={s.sheetInner}
            data={LIST_ITEMS}
            keyExtractor={t => t}
            nestedScrollEnabled
            ListHeaderComponent={
              <View>
                <Text style={s.sheetTitle}>FlatList test</Text>
                <Text style={s.sheetNote}>
                  Does the list render and scroll at all inside a fixed-height
                  RNHostView? Risk: virtualisation needs a real measured
                  height, which a sheet that sizes to content may not give.
                </Text>
              </View>
            }
            renderItem={({ item }) => <Text style={s.row}>{item}</Text>}
          />
        </RNHostView>
      </BottomSheet>

      {/* -------------------------------------------------------------- */}
      <BottomSheet isPresented={openKeyboard} onDismiss={() => setOpenKeyboard(false)}>
        <RNHostView style={{ height: 300 }}>
          <View style={s.sheetInner}>
            <Text style={s.sheetTitle}>Keyboard test</Text>
            <Text style={s.sheetNote}>
              Tap the field, type. Expected: field stays visible above the
              keyboard. Risk: keyboard covers it, or the sheet resizes wrong
              (react-native-keyboard-controller is wired to the main window).
            </Text>
            <TextInput
              testID="risk-textinput"
              style={s.input}
              placeholder="Type here"
              placeholderTextColor="#888"
              value={text}
              onChangeText={setText}
              autoFocus
            />
            <Text style={s.sheetNote}>Typed: {text || '(nothing yet)'}</Text>
          </View>
        </RNHostView>
      </BottomSheet>

      {/* -------------------------------------------------------------- */}
      <BottomSheet isPresented={openSlider} onDismiss={() => setOpenSlider(false)}>
        <RNHostView style={{ height: 260 }}>
          <View style={s.sheetInner}>
            <Text style={s.sheetTitle}>Slider test</Text>
            <Text style={s.sheetNote}>
              Drag the slider LEFT/RIGHT. Expected: only the slider moves.
              Risk: a diagonal drag also nudges the sheet, or the sheet
              intercepts the gesture entirely.
            </Text>
            <Slider
              testID="risk-slider"
              minimumValue={0}
              maximumValue={100}
              value={sliderVal}
              onValueChange={setSliderVal}
            />
            <Text style={s.sheetNote}>Value: {Math.round(sliderVal)}</Text>
          </View>
        </RNHostView>
      </BottomSheet>
    </View>
  )
}

function Btn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Host matchContents style={s.btnHost}>
      <UiButton onPress={onPress}>{label}</UiButton>
    </Host>
  )
}

const s = StyleSheet.create({
  root:  {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000,
    backgroundColor: '#0a0e16', padding: 16, paddingTop: 60, gap: 12,
  },
  title: { color: '#fff', fontSize: 20, fontWeight: '700' },
  sub:   { color: '#9aa5b1', marginBottom: 12 },
  btnHost: { height: 44 },
  sheetInner: { padding: 16, gap: 8 },
  sheetTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 4 },
  sheetNote:  { color: '#9aa5b1', fontSize: 13, marginBottom: 12 },
  row: { color: '#fff', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#222' },
  input: {
    borderWidth: 1, borderColor: '#444', borderRadius: 8, padding: 10,
    color: '#fff', marginBottom: 8,
  },
})
