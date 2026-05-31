import { useState } from 'react';
import { View, TextInput, Pressable, Text, StyleSheet } from 'react-native';
import { useColorScheme } from 'react-native';
import { resolveTokens } from '@/src/theme/tokens';

interface CommandBarProps {
  onSend: (text: string) => void;
  onStop: () => void;
}

export function CommandBar({ onSend, onStop }: CommandBarProps) {
  const [text, setText] = useState('');
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const t = resolveTokens(scheme);

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  }

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onStop}
        style={[styles.stopChip, { backgroundColor: t.bgElev2, borderColor: t.border }]}
      >
        <Text style={[styles.stopText, { color: t.fg2 }]}>■ Zatrzymaj</Text>
      </Pressable>
      <View style={[styles.bar, { backgroundColor: t.bgElev, borderColor: t.border }]}>
        <TextInput
          style={[styles.input, { color: t.fg }]}
          placeholder="Napisz polecenie…"
          placeholderTextColor={t.muted}
          value={text}
          onChangeText={setText}
          onSubmitEditing={handleSend}
          returnKeyType="send"
          multiline={false}
        />
        <Pressable
          onPress={handleSend}
          style={[styles.sendBtn, { backgroundColor: t.accent }]}
        >
          <Text style={[styles.sendIcon, { color: t.accentFg }]}>↑</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 18,
    gap: 8,
  },
  stopChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 99,
    borderWidth: 1,
  },
  stopText: {
    fontSize: 13,
    fontWeight: '600',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    borderWidth: 1,
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    fontSize: 14,
    marginRight: 8,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendIcon: {
    fontSize: 18,
    fontWeight: '700',
  },
});
