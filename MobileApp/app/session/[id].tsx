import { useEffect, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, useColorScheme } from 'react-native';
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

  // Subscribe to the session channel on mount
  useEffect(() => {
    const h = useStore.getState().handles;
    const sub = h?.subscribeSession(id, useStore.getState().applySessionEvent);
    return () => { sub?.unsubscribe(); };
  }, [id]);

  const title = useStore((s) => s.sessions.get(id)?.title ?? null);
  const activity = useStore((s) => s.sessions.get(id)?.activity ?? null);
  const historyMap = useStore((s) => s.history);
  const blocks = useMemo(() => historyMap.get(id) ?? [], [historyMap, id]);
  const phoneToken = useStore((s) => s.phoneToken);

  const isWaiting = activity === 'waitingUser';

  function activityLine(): string {
    switch (activity) {
      case 'running': return 'Claude pracuje…';
      case 'waitingUser': return 'Czeka na Twoją decyzję';
      case 'waitingTool': return 'Narzędzie w trakcie…';
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

  function handleDeny() {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'denyPermission', sessionId: id });
  }

  return (
    <View style={[styles.container, { backgroundColor: t.bg }]}>
      {/* Header */}
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

      {/* History list */}
      <FlatList<HistoryBlock>
        data={blocks}
        keyExtractor={(item) => item.uuid}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => <HistoryBlockView block={item} />}
        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: t.muted }]}>Brak historii</Text>
        }
      />

      {/* Permission prompt when waiting */}
      {isWaiting && (
        <View style={styles.permWrap}>
          <PermissionPrompt onApprove={handleApprove} onDeny={handleDeny} />
        </View>
      )}

      {/* Command bar */}
      <CommandBar onSend={handleSend} onStop={handleStop} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
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
