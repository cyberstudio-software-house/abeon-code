import { useEffect, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { useStore } from '@/src/store';
import { resolveTokens } from '@/src/theme/tokens';
import { SessionCard } from '@/src/components/SessionCard';
import { dispatchCommand } from '@/src/lib/dispatch';
import type { Session } from '@/src/store/sessionsSlice';

export default function Sessions() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const t = resolveTokens(scheme);

  // Open the device channel when this tab mounts (idempotent — connect guards itself)
  useEffect(() => {
    useStore.getState().connect();
  }, []);

  const sessions = useStore((s) => s.sessions);
  const phoneToken = useStore((s) => s.phoneToken);

  const list = useMemo(
    () => [...sessions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt),
    [sessions],
  );

  function handleApprove(sessionId: string) {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'approvePermission', sessionId });
  }

  function handleDeny(sessionId: string) {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'denyPermission', sessionId });
  }

  return (
    <View style={[styles.container, { backgroundColor: t.bg }]}>
      <FlatList<Session>
        data={list}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <SessionCard
            session={item}
            onPress={() => { router.push(`/session/${item.id}`); }}
            onApprove={() => handleApprove(item.id)}
            onDeny={() => handleDeny(item.id)}
          />
        )}
        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: t.muted }]}>Brak aktywnych sesji</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    flexGrow: 1,
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 60,
    fontSize: 15,
  },
});
