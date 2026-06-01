import { Tabs } from 'expo-router';
import { type ColorValue } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// Import the Ionicons subpath directly, NOT the `@expo/vector-icons` barrel: the barrel
// pulls in every icon family lazily (incl. FontAwesome6, whose vendor glyphmap is missing
// in this version) and breaks the Metro bundle. The subpath loads only Ionicons.
import Ionicons from '@expo/vector-icons/Ionicons';
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
  // Top edge only: pushes the banner + screen content below the status bar / notch. The
  // bottom inset is handled by the tab bar itself (React Navigation).
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.bg }}>
      <ConnectionBanner />
      <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: t.accent, tabBarInactiveTintColor: t.muted, tabBarStyle: { backgroundColor: t.bgElev, borderTopColor: t.border } }}>
        <Tabs.Screen name="sessions" options={{ title: 'Sesje', tabBarIcon: tabIcon('albums', 'albums-outline') }} />
        <Tabs.Screen name="activity" options={{ title: 'Aktywność', tabBarIcon: tabIcon('flash', 'flash-outline') }} />
        <Tabs.Screen name="settings" options={{ title: 'Ustawienia', tabBarIcon: tabIcon('settings', 'settings-outline') }} />
      </Tabs>
    </SafeAreaView>
  );
}
