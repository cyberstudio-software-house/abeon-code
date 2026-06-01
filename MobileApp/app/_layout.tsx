import { useEffect, useState } from 'react';
import { Stack, useRouter } from 'expo-router';
import { useFonts, Fraunces_600SemiBold } from '@expo-google-fonts/fraunces';
import { Geist_400Regular, Geist_600SemiBold } from '@expo-google-fonts/geist';
import { GeistMono_500Medium } from '@expo-google-fonts/geist-mono';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useStore } from '@/src/store';
import { registerForPush, initPushHandler, addPushResponseListener } from '@/src/lib/push';
import { loadServerUrl } from '@/src/lib/secure';
import { setCloudServiceUrl } from '@/src/lib/config';

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Fraunces_600SemiBold, Geist_400Regular, Geist_600SemiBold, GeistMono_500Medium });
  const hydrate = useStore((s) => s.hydrate);
  const [hydrated, setHydrated] = useState(false);
  // Apply the persisted CloudService URL before any API call. Awaited as part of the
  // hydration gate so the (tabs)/pair screens never fire a request against a stale URL.
  useEffect(() => {
    (async () => {
      const url = await loadServerUrl().catch(() => null);
      if (url) setCloudServiceUrl(url);
      await hydrate();
    })().finally(() => setHydrated(true));
  }, [hydrate]);
  useEffect(() => { initPushHandler(); }, []);
  const phoneToken = useStore((s) => s.phoneToken);
  useEffect(() => { if (phoneToken) void registerForPush(phoneToken); }, [phoneToken]);
  const router = useRouter();
  useEffect(() => {
    const sub = addPushResponseListener((sessionId) => router.push(`/session/${sessionId}`));
    return () => sub.remove();
  }, [router]);
  if (!fontsLoaded || !hydrated) return null;
  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
