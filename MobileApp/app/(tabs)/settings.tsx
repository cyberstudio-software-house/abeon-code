import { View, Text, Pressable } from 'react-native';
import { useStore } from '@/src/store';

export default function Settings() {
  // Select fields individually — a new-object selector without useShallow causes
  // infinite re-renders (the DesktopApp Zustand gotcha).
  const deviceId = useStore((s) => s.deviceId);
  const unpair = useStore((s) => s.unpair);
  return (
    <View style={{ flex: 1, padding: 24, gap: 16 }}>
      <Text>Urządzenie: {deviceId ?? '—'}</Text>
      <Pressable onPress={() => { void unpair(); }}><Text style={{ color: '#c14a3d' }}>Odłącz</Text></Pressable>
    </View>
  );
}
