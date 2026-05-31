import { View, Text, Pressable } from 'react-native';
import { useStore } from '@/src/store';

export default function Settings() {
  // Select fields individually — a new-object selector without useShallow causes
  // infinite re-renders (the DesktopApp Zustand gotcha).
  const deviceId = useStore((s) => s.deviceId);
  const unpair = useStore((s) => s.unpair);
  const disconnect = useStore((s) => s.disconnect);
  const resetSessions = useStore((s) => s.resetSessions);

  // Tear down the live connection and clear session state before clearing
  // credentials — otherwise the socket leaks and a later re-pair finds a stale
  // truthy `handles`, so connect() short-circuits and never re-subscribes.
  function handleUnpair() {
    disconnect();
    resetSessions();
    void unpair();
  }

  return (
    <View style={{ flex: 1, padding: 24, gap: 16 }}>
      <Text>Urządzenie: {deviceId ?? '—'}</Text>
      <Pressable onPress={handleUnpair}><Text style={{ color: '#c14a3d' }}>Odłącz</Text></Pressable>
    </View>
  );
}
