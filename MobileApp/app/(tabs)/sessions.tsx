import { useEffect, useMemo } from 'react';
import { View, Text, SectionList, StyleSheet, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { useStore } from '@/src/store';
import { resolveTokens } from '@/src/theme/tokens';
import { SessionCard } from '@/src/components/SessionCard';
import { dispatchCommand } from '@/src/lib/dispatch';
import { groupByProject } from '@/src/lib/roster';

export default function Sessions() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const t = resolveTokens(scheme);

  // Open the device channel when this tab mounts (idempotent — connect guards itself)
  useEffect(() => {
    useStore.getState().connect();
  }, []);

  const sessions = useStore((s) => s.sessions);
  const phoneToken = useStore((s) => s.phoneToken);

  const sections = useMemo(() => groupByProject([...sessions.values()]), [sessions]);

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
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionHeader, { color: t.muted }]}>{section.title}</Text>
        )}
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
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 60,
    fontSize: 15,
  },
});
