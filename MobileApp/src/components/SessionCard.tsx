import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useColorScheme } from 'react-native';
import { resolveTokens } from '@/src/theme/tokens';
import type { Session } from '@/src/store/sessionsSlice';

interface SessionCardProps {
  session: Session;
  onPress: () => void;
  onApprove?: () => void;
  onDeny?: () => void;
}

function glowColor(activity: Session['activity'], tokens: ReturnType<typeof resolveTokens>): string {
  switch (activity) {
    case 'running': return tokens.success;
    case 'waitingUser': return tokens.accent;
    case 'waitingTool': return tokens.accent2;
    case 'idle': return tokens.muted;
    default: return tokens.muted;
  }
}

function activityLabel(activity: Session['activity']): string {
  switch (activity) {
    case 'running': return 'Claude pracuje…';
    case 'waitingUser': return 'Czeka';
    case 'waitingTool': return 'Narzędzie…';
    case 'idle': return 'Bezczynna';
    default: return '';
  }
}

export function SessionCard({ session, onPress, onApprove, onDeny }: SessionCardProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const t = resolveTokens(scheme);

  const isWaiting = session.activity === 'waitingUser';
  // Active = not idle: gets a bright card + a colored spine. Idle is dimmed so the few
  // sessions you actually care about stand out at a glance.
  const isActive = session.activity != null && session.activity !== 'idle';
  const dotColor = glowColor(session.activity, t);

  const totalTokens = session.usage
    ? session.usage.tokens.input + session.usage.tokens.output
    : null;

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.card,
        {
          backgroundColor: isActive ? t.bgElev2 : t.bgElev,
          borderColor: isWaiting ? t.accent : t.border,
          borderWidth: isWaiting ? 1.5 : 1,
          borderLeftColor: isActive ? dotColor : t.border,
          borderLeftWidth: isActive ? 4 : 1,
          opacity: isActive ? 1 : 0.55,
        },
      ]}
    >
      {/* Header row */}
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text
          style={[styles.title, { color: t.fg }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {session.title ?? 'Sesja'}
        </Text>
        {session.activity != null && (
          <Text
            style={[
              styles.activityLabel,
              {
                color: isWaiting ? t.accentFg : (session.activity === 'running' ? t.success : t.fg2),
                backgroundColor: isWaiting ? t.accent : 'transparent',
              },
            ]}
          >
            {activityLabel(session.activity)}
          </Text>
        )}
      </View>

      {/* Usage line */}
      {session.usage != null && totalTokens != null && (
        <Text style={[styles.usageLine, { color: t.muted, fontVariant: ['tabular-nums'] }]}>
          {session.usage.costUsd.toFixed(4)}$ · {totalTokens.toLocaleString()} tok
        </Text>
      )}

      {/* Inline approve/deny for waitingUser */}
      {isWaiting && (
        <View style={styles.actions}>
          <Pressable
            onPress={onApprove}
            style={[styles.actionBtn, { backgroundColor: t.accent }]}
          >
            <Text style={[styles.actionBtnText, { color: t.accentFg }]}>Zatwierdź</Text>
          </Pressable>
          <Pressable
            onPress={onDeny}
            style={[styles.actionBtn, { backgroundColor: t.bgElev2 }]}
          >
            <Text style={[styles.actionBtnText, { color: t.fg2 }]}>Odrzuć</Text>
          </Pressable>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dot: {
    width: 11,
    height: 11,
    borderRadius: 99,
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  activityLabel: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 99,
    overflow: 'hidden',
  },
  usageLine: {
    marginTop: 7,
    fontSize: 11,
    marginLeft: 21,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
  },
  actionBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
