import { Tabs } from 'expo-router';
import { View, type ColorValue } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { resolveTokens } from '@/src/theme/tokens';
import { useColorScheme } from 'react-native';
import { ConnectionBanner } from '@/src/components/ConnectionBanner';

// Ionicons ship their own font, so the glyphs render identically on Android/iOS — unlike
// the Unicode symbols (◰ ⚡ ⚙) from the design mockup, which fall back to "tofu" boxes when
// the system font lacks them.
type IoniconName = keyof typeof Ionicons.glyphMap;
function tabIcon(active: IoniconName, inactive: IoniconName) {
  return ({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) => (
    <Ionicons name={focused ? active : inactive} size={size} color={color} />
  );
}

export default function TabsLayout() {
  const t = resolveTokens(useColorScheme() === 'dark' ? 'dark' : 'light');
  return (
    <View style={{ flex: 1 }}>
      <ConnectionBanner />
      <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: t.accent, tabBarInactiveTintColor: t.muted, tabBarStyle: { backgroundColor: t.bgElev, borderTopColor: t.border } }}>
        <Tabs.Screen name="sessions" options={{ title: 'Sesje', tabBarIcon: tabIcon('albums', 'albums-outline') }} />
        <Tabs.Screen name="activity" options={{ title: 'Aktywność', tabBarIcon: tabIcon('flash', 'flash-outline') }} />
        <Tabs.Screen name="settings" options={{ title: 'Ustawienia', tabBarIcon: tabIcon('settings', 'settings-outline') }} />
      </Tabs>
    </View>
  );
}
