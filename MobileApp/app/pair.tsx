import { useState } from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useStore } from '@/src/store';
import { claimScannedCode } from '@/src/lib/pairing';
import { resolveTokens } from '@/src/theme/tokens';
import { registerForPush } from '@/src/lib/push';

export default function Pair() {
  const t = resolveTokens(useColorScheme() === 'dark' ? 'dark' : 'light');
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const pair = useStore((s) => s.pair);
  const router = useRouter();

  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        <Text style={{ color: t.fg, marginBottom: 16 }}>Potrzebujemy dostępu do aparatu, aby zeskanować kod parowania.</Text>
        <Text onPress={() => void requestPermission()} style={{ color: t.accent, fontWeight: '600' }}>Zezwól na aparat</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={busy ? undefined : ({ data }: { data: string }) => {
          setBusy(true);
          claimScannedCode(data, async (c) => { await pair(c); void registerForPush(c.phoneToken); router.replace('/(tabs)/sessions'); })
            .then((claimed) => { if (!claimed) setBusy(false); })
            .catch(() => setBusy(false));
        }}
      />
      <View style={styles.hint}><Text style={{ color: '#fff', fontWeight: '600' }}>Zeskanuj kod QR z aplikacji desktopowej</Text></View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  hint: { position: 'absolute', bottom: 64, left: 0, right: 0, alignItems: 'center' },
});
