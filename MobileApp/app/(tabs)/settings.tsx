import { useState } from 'react';
import { View, Text, Pressable, TextInput, useColorScheme } from 'react-native';
import { useStore } from '@/src/store';
import { getCloudServiceUrl, setCloudServiceUrl } from '@/src/lib/config';
import { saveServerUrl } from '@/src/lib/secure';
import { resolveTokens } from '@/src/theme/tokens';

export default function Settings() {
  const t = resolveTokens(useColorScheme() === 'dark' ? 'dark' : 'light');
  // Select fields individually — a new-object selector without useShallow causes
  // infinite re-renders (the DesktopApp Zustand gotcha).
  const deviceId = useStore((s) => s.deviceId);
  const unpair = useStore((s) => s.unpair);
  const disconnect = useStore((s) => s.disconnect);
  const resetSessions = useStore((s) => s.resetSessions);

  const [url, setUrl] = useState(getCloudServiceUrl());
  const [saved, setSaved] = useState(false);

  async function saveUrl() {
    setCloudServiceUrl(url);
    await saveServerUrl(url.trim());
    setSaved(true);
  }

  // Tear down the live connection and clear session state before clearing credentials —
  // otherwise the socket leaks and a later re-pair finds a stale truthy `handles`.
  function handleUnpair() {
    disconnect();
    resetSessions();
    void unpair();
  }

  return (
    <View style={{ flex: 1, padding: 24, gap: 20, backgroundColor: t.bg }}>
      <View style={{ gap: 8 }}>
        <Text style={{ color: t.fg2, fontSize: 12, fontWeight: '600' }}>Adres CloudService</Text>
        <TextInput
          value={url}
          onChangeText={(v) => { setUrl(v); setSaved(false); }}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://192.168.0.174:18080"
          placeholderTextColor={t.muted}
          style={{ color: t.fg, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, backgroundColor: t.bgElev }}
        />
        <Text style={{ color: t.muted, fontSize: 11 }}>
          Na telefonie użyj adresu LAN komputera (nie localhost), np. http://192.168.0.174:18080
        </Text>
        <Pressable onPress={() => void saveUrl()} style={{ alignSelf: 'flex-start', backgroundColor: t.accent, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10 }}>
          <Text style={{ color: t.accentFg, fontWeight: '600' }}>{saved ? 'Zapisano ✓' : 'Zapisz adres'}</Text>
        </Pressable>
      </View>

      <View style={{ height: 1, backgroundColor: t.border }} />

      <Text style={{ color: t.fg }}>Urządzenie: {deviceId ?? '—'}</Text>
      <Pressable onPress={handleUnpair}><Text style={{ color: t.danger, fontWeight: '600' }}>Odłącz</Text></Pressable>
    </View>
  );
}
