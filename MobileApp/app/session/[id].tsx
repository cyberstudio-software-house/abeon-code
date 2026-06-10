import { useEffect, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, useColorScheme, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { useStore } from '@/src/store';
import { resolveTokens } from '@/src/theme/tokens';
import { HistoryBlockView } from '@/src/components/HistoryBlockView';
import { PermissionPrompt } from '@/src/components/PermissionPrompt';
import { CommandBar } from '@/src/components/CommandBar';
import { dispatchCommand } from '@/src/lib/dispatch';
import type { HistoryBlock } from '@/src/types/HistoryBlock';

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const t = resolveTokens(scheme);

  const phoneToken = useStore((s) => s.phoneToken);

  useEffect(() => {
    useStore.getState().connect();
    const h = useStore.getState().handles;
    const sub = h?.subscribeSession(id, useStore.getState().applySessionEvent);
    if (phoneToken) {
      void dispatchCommand(phoneToken, { type: 'requestHistory', sessionId: id });
    }
    return () => { sub?.unsubscribe(); };
  }, [id, phoneToken]);

  const title = useStore((s) => s.sessions.get(id)?.title ?? null);
  const activity = useStore((s) => s.sessions.get(id)?.activity ?? null);
  const historyMap = useStore((s) => s.history);
  const blocks = useMemo(() => historyMap.get(id) ?? [], [historyMap, id]);

  const isPermission = activity === 'waitingTool';

  const toolLabel = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'toolUse') {
        return `${b.name}${b.input_summary ? ` · ${b.input_summary}` : ''}`;
      }
    }
    return null;
  }, [blocks]);

  function activityLine(): string {
    switch (activity) {
      case 'running': return 'Claude pracuje…';
      case 'waitingUser': return 'Czeka na Twoją odpowiedź';
      case 'waitingTool': return 'Prośba o zgodę';
      case 'idle': return 'Bezczynna';
      default: return '';
    }
  }

  function handleSend(text: string) {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'sendPrompt', sessionId: id, text });
  }

  function handleStop() {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'stopSession', sessionId: id });
  }

  function handleApprove() {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'approvePermission', sessionId: id });
  }

  function handleApproveAlways() {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'approveAlwaysPermission', sessionId: id });
  }

  function handleDeny() {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'denyPermission', sessionId: id });
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: t.bg }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: t.border, backgroundColor: t.bgElev }]}>
        <Text style={[styles.headerTitle, { color: t.fg }]} numberOfLines={1}>
          {title ?? 'Sesja'}
        </Text>
        {activity != null && (
          <Text style={[styles.headerActivity, { color: activity === 'running' ? t.success : t.fg2 }]}>
            {activityLine()}
          </Text>
        )}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <FlatList<HistoryBlock>
          data={blocks}
          keyExtractor={(item) => item.uuid}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => <HistoryBlockView block={item} />}
          ListEmptyComponent={
            <Text style={[styles.emptyText, { color: t.muted }]}>Brak historii</Text>
          }
        />

        {isPermission && (
          <View style={styles.permWrap}>
            <PermissionPrompt
              toolLabel={toolLabel}
              onApprove={handleApprove}
              onApproveAlways={handleApproveAlways}
              onDeny={handleDeny}
            />
          </View>
        )}

        <CommandBar onSend={handleSend} onStop={handleStop} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  headerActivity: {
    fontSize: 13,
    marginTop: 3,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 40,
    fontSize: 14,
  },
  permWrap: {
    paddingHorizontal: 14,
  },
});
