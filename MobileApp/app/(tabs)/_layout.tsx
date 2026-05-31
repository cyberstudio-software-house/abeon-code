import { Tabs } from 'expo-router';
import { View } from 'react-native';
import { resolveTokens } from '@/src/theme/tokens';
import { useColorScheme } from 'react-native';
import { ConnectionBanner } from '@/src/components/ConnectionBanner';

export default function TabsLayout() {
  const t = resolveTokens(useColorScheme() === 'dark' ? 'dark' : 'light');
  return (
    <View style={{ flex: 1 }}>
      <ConnectionBanner />
      <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: t.accent, tabBarStyle: { backgroundColor: t.bgElev, borderTopColor: t.border } }}>
        <Tabs.Screen name="sessions" options={{ title: 'Sesje' }} />
        <Tabs.Screen name="activity" options={{ title: 'Aktywność' }} />
        <Tabs.Screen name="settings" options={{ title: 'Ustawienia' }} />
      </Tabs>
    </View>
  );
}
