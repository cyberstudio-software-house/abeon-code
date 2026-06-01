import { useEffect, useMemo, useState } from 'react';
import { View, Text, SectionList, Pressable, StyleSheet, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { useStore } from '@/src/store';
import { resolveTokens } from '@/src/theme/tokens';
import { SessionCard } from '@/src/components/SessionCard';
import { dispatchCommand } from '@/src/lib/dispatch';
import { groupByProject, visibleSessions, COLLAPSED_LIMIT } from '@/src/lib/roster';

export default function Sessions() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const t = resolveTokens(scheme);

  // Open the device channel when this tab mounts (idempotent — connect guards itself)
  useEffect(() => {
    useStore.getState().connect();
  }, []);

  const sessions = useStore((s) => s.sessions);
  const phoneToken = useStore((s) => s.phoneToken);
  // Per-project expand state (keyed by project title). New Set on toggle so useMemo reruns.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggle(title: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title); else next.add(title);
      return next;
    });
  }

  const sections = useMemo(
    () =>
      groupByProject([...sessions.values()]).map((sec) => ({
        title: sec.title,
        total: sec.data.length,
        data: visibleSessions(sec.data, expanded.has(sec.title)),
      })),
    [sessions, expanded],
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
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled={false}
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
        renderSectionFooter={({ section }) => {
          const isExp = expanded.has(section.title);
          const hidden = section.total - section.data.length;
          if (!isExp && hidden > 0) {
            return (
              <Pressable onPress={() => toggle(section.title)} style={styles.toggle}>
                <Text style={[styles.toggleText, { color: t.accent }]}>Pokaż wszystkie ({section.total})</Text>
              </Pressable>
            );
          }
          if (isExp && section.total > COLLAPSED_LIMIT) {
            return (
              <Pressable onPress={() => toggle(section.title)} style={styles.toggle}>
                <Text style={[styles.toggleText, { color: t.muted }]}>Zwiń</Text>
              </Pressable>
            );
          }
          return null;
        }}
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
  toggle: {
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginBottom: 6,
  },
  toggleText: {
    fontSize: 13,
    fontWeight: '600',
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 60,
    fontSize: 15,
  },
});
