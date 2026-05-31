import { View, Text, StyleSheet } from 'react-native';
import { useColorScheme } from 'react-native';
import { resolveTokens } from '@/src/theme/tokens';
import type { HistoryBlock } from '@/src/types/HistoryBlock';

interface HistoryBlockViewProps {
  block: HistoryBlock;
}

export function HistoryBlockView({ block }: HistoryBlockViewProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const t = resolveTokens(scheme);

  switch (block.kind) {
    case 'userText':
      return (
        <View style={styles.userTextWrap}>
          <View style={[styles.userBubble, { backgroundColor: t.accent }]}>
            <Text style={[styles.bubbleText, { color: t.accentFg }]}>{block.text}</Text>
          </View>
        </View>
      );

    case 'assistantText':
      return (
        <View style={[styles.assistantBubble, { backgroundColor: t.bgElev, borderColor: t.border }]}>
          <Text style={[styles.bubbleText, { color: t.fg }]}>{block.text}</Text>
        </View>
      );

    case 'assistantThinking':
      return (
        <Text style={[styles.thinkingText, { color: t.muted }]}>{block.text}</Text>
      );

    case 'toolUse':
      return (
        <View style={[styles.toolRow, { backgroundColor: t.bgElev, borderColor: t.border }]}>
          <Text style={[styles.monoText, { color: t.accent }]}>{'✎ '}</Text>
          <Text style={[styles.monoText, { color: t.fg2, flex: 1 }]} numberOfLines={2}>
            {block.name}{block.input_summary ? ` · ${block.input_summary}` : ''}
          </Text>
        </View>
      );

    case 'toolResult':
      return (
        <View style={[styles.toolRow, { backgroundColor: t.bgElev2, borderColor: block.is_error ? t.danger : t.border }]}>
          <Text
            style={[styles.monoText, { color: block.is_error ? t.danger : t.fg2, flex: 1 }]}
            numberOfLines={3}
          >
            {block.content}
          </Text>
        </View>
      );

    case 'attachment':
      return (
        <View style={[styles.attachmentRow, { backgroundColor: t.bgElev, borderColor: t.border }]}>
          <Text style={[styles.monoText, { color: t.fg2 }]}>{'📎 '}{block.name}</Text>
        </View>
      );

    case 'system':
      return (
        <Text style={[styles.systemText, { color: t.muted }]}>{block.message}</Text>
      );

    default:
      return null;
  }
}

const styles = StyleSheet.create({
  userTextWrap: {
    alignItems: 'flex-end',
    marginVertical: 3,
  },
  userBubble: {
    maxWidth: '80%',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  assistantBubble: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginVertical: 3,
  },
  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
  },
  thinkingText: {
    fontSize: 13,
    fontStyle: 'italic',
    marginVertical: 3,
    paddingHorizontal: 4,
  },
  toolRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginVertical: 3,
  },
  monoText: {
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginVertical: 3,
  },
  systemText: {
    fontSize: 11,
    marginVertical: 3,
    paddingHorizontal: 4,
  },
});
