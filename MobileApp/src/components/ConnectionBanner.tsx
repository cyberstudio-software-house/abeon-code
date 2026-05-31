import { View, Text, StyleSheet } from 'react-native';
import { useColorScheme } from 'react-native';
import { resolveTokens } from '@/src/theme/tokens';
import { useStore } from '@/src/store';

export function ConnectionBanner() {
  const status = useStore((s) => s.connectionStatus);
  const t = resolveTokens(useColorScheme() === 'dark' ? 'dark' : 'light');

  if (status === 'connected' || status === 'idle') return null;

  const isConnecting = status === 'connecting';

  return (
    <View style={[styles.banner, { backgroundColor: isConnecting ? t.accent2 : t.danger }]}>
      <Text style={[styles.text, { color: isConnecting ? t.accentFg : '#ffffff' }]}>
        {isConnecting ? 'Łączenie…' : 'Offline — ponawiam połączenie'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    width: '100%',
    paddingVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: 12,
    fontWeight: '600',
  },
});
