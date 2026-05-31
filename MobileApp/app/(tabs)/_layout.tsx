import { Tabs } from 'expo-router';
import { resolveTokens } from '@/src/theme/tokens';
import { useColorScheme } from 'react-native';

export default function TabsLayout() {
  const t = resolveTokens(useColorScheme() === 'dark' ? 'dark' : 'light');
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: t.accent, tabBarStyle: { backgroundColor: t.bgElev, borderTopColor: t.border } }}>
      <Tabs.Screen name="sessions" options={{ title: 'Sesje' }} />
      <Tabs.Screen name="activity" options={{ title: 'Aktywność' }} />
      <Tabs.Screen name="settings" options={{ title: 'Ustawienia' }} />
    </Tabs>
  );
}
