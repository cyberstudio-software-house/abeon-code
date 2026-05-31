import { useEffect, useState } from 'react';
import { Stack, useRouter } from 'expo-router';
import { useFonts, Fraunces_600SemiBold } from '@expo-google-fonts/fraunces';
import { Geist_400Regular, Geist_600SemiBold } from '@expo-google-fonts/geist';
import { GeistMono_500Medium } from '@expo-google-fonts/geist-mono';
import * as Notifications from 'expo-notifications';
import { useStore } from '@/src/store';
import { registerForPush } from '@/src/lib/push';

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Fraunces_600SemiBold, Geist_400Regular, Geist_600SemiBold, GeistMono_500Medium });
  const hydrate = useStore((s) => s.hydrate);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { hydrate().finally(() => setHydrated(true)); }, [hydrate]);
  const phoneToken = useStore((s) => s.phoneToken);
  useEffect(() => { if (phoneToken) void registerForPush(phoneToken); }, [phoneToken]);
  const router = useRouter();
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const data = resp.notification.request.content.data as { sessionId?: string } | undefined;
      if (data?.sessionId) router.push(`/session/${data.sessionId}`);
    });
    return () => sub.remove();
  }, [router]);
  if (!fontsLoaded || !hydrated) return null;
  return <Stack screenOptions={{ headerShown: false }} />;
}
