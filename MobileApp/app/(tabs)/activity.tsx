import { useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { useStore } from '@/src/store';
import { resolveTokens } from '@/src/theme/tokens';
import { SessionCard } from '@/src/components/SessionCard';
import { dispatchCommand } from '@/src/lib/dispatch';
import type { Session } from '@/src/store/sessionsSlice';

export default function Activity() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const t = resolveTokens(scheme);

  const sessions = useStore((s) => s.sessions);
  const phoneToken = useStore((s) => s.phoneToken);

  const waitingList = useMemo(
    () =>
      [...sessions.values()]
        .filter((s) => s.activity === 'waitingUser')
        .sort((a, b) => b.lastEventAt - a.lastEventAt),
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
        data={waitingList}
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
          <Text style={[styles.emptyText, { color: t.muted }]}>Nic nie czeka na Ciebie</Text>
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
