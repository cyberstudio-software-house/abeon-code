import { Stack } from 'expo-router';
import { useFonts, Fraunces_600SemiBold } from '@expo-google-fonts/fraunces';
import { Geist_400Regular, Geist_600SemiBold } from '@expo-google-fonts/geist';
import { GeistMono_500Medium } from '@expo-google-fonts/geist-mono';

export default function RootLayout() {
  const [loaded] = useFonts({ Fraunces_600SemiBold, Geist_400Regular, Geist_600SemiBold, GeistMono_500Medium });
  if (!loaded) return null;
  return <Stack screenOptions={{ headerShown: false }} />;
}
