import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useColorScheme } from 'react-native';
import { resolveTokens } from '@/src/theme/tokens';

interface PermissionPromptProps {
  toolLabel?: string | null;
  onApprove: () => void;
  onApproveAlways: () => void;
  onDeny: () => void;
}

export function PermissionPrompt({ toolLabel, onApprove, onApproveAlways, onDeny }: PermissionPromptProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const t = resolveTokens(scheme);

  return (
    <View style={[styles.card, { backgroundColor: t.bgElev, borderColor: t.accent }]}>
      <Text style={[styles.label, { color: t.accent }]}>⚠ Prośba o zgodę</Text>
      <Text style={[styles.question, { color: t.fg }]}>
        {toolLabel ? `Claude chce użyć: ${toolLabel}` : 'Sesja czeka na Twoją decyzję'}
      </Text>
      <View style={styles.actions}>
        <Pressable onPress={onApprove} style={[styles.btn, { backgroundColor: t.accent }]}>
          <Text style={[styles.btnText, { color: t.accentFg }]}>Zatwierdź</Text>
        </Pressable>
        <Pressable onPress={onDeny} style={[styles.btnOutline, { borderColor: t.danger }]}>
          <Text style={[styles.btnText, { color: t.danger }]}>Odrzuć</Text>
        </Pressable>
      </View>
      <Pressable onPress={onApproveAlways} style={[styles.btnGhost, { borderColor: t.border }]}>
        <Text style={[styles.btnText, { color: t.fg2 }]}>Zatwierdź i nie pytaj</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1.5,
    padding: 16,
    marginVertical: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontFamily: 'monospace',
    marginBottom: 8,
  },
  question: {
    fontSize: 15,
    fontWeight: '500',
    marginBottom: 14,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
  },
  btnOutline: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnGhost: {
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
