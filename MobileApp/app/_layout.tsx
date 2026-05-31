import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { useFonts, Fraunces_600SemiBold } from '@expo-google-fonts/fraunces';
import { Geist_400Regular, Geist_600SemiBold } from '@expo-google-fonts/geist';
import { GeistMono_500Medium } from '@expo-google-fonts/geist-mono';
import { useStore } from '@/src/store';

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Fraunces_600SemiBold, Geist_400Regular, Geist_600SemiBold, GeistMono_500Medium });
  const hydrate = useStore((s) => s.hydrate);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { hydrate().finally(() => setHydrated(true)); }, [hydrate]);
  if (!fontsLoaded || !hydrated) return null;
  return <Stack screenOptions={{ headerShown: false }} />;
}
