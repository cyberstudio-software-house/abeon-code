import { useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, useColorScheme } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useStore } from '@/src/store';
import { extractCode } from '@/src/lib/pairing';
import { claimPairing } from '@/src/lib/api';
import { registerForPush } from '@/src/lib/push';
import { resolveTokens } from '@/src/theme/tokens';

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  if (typeof e === 'string') return e;
  return 'Nie udało się sparować. Sprawdź połączenie z CloudService.';
}

export default function Pair() {
  const t = resolveTokens(useColorScheme() === 'dark' ? 'dark' : 'light');
  const [permission, requestPermission] = useCameraPermissions();
  const pair = useStore((s) => s.pair);
  const router = useRouter();
  // Ref lock is synchronous (not subject to React state batching), so a valid scan can
  // never re-trigger on the next camera frame — the cause of the scanner "jumping".
  const locked = useRef(false);
  const [status, setStatus] = useState<'scanning' | 'claiming' | 'error'>('scanning');
  const [error, setError] = useState<string | null>(null);

  function handleScan(data: string) {
    if (locked.current) return;
    const code = extractCode(data);
    if (!code) return; // unrelated QR: keep scanning, do NOT lock (avoids freezing on a stray code)
    locked.current = true;
    setStatus('claiming');
    claimPairing(code)
      .then(async (c) => {
        await pair(c);
        void registerForPush(c.phoneToken);
        router.replace('/(tabs)/sessions');
      })
      .catch((e) => {
        setError(errorText(e));
        setStatus('error');
      });
  }

  function retry() {
    locked.current = false;
    setError(null);
    setStatus('scanning');
  }

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
        // Disable the callback entirely unless actively scanning — combined with the ref
        // lock this guarantees a single handled scan per attempt.
        onBarcodeScanned={status === 'scanning' ? ({ data }: { data: string }) => handleScan(data) : undefined}
      />
      <View style={styles.hint}>
        {status === 'scanning' && <Text style={styles.hintText}>Zeskanuj kod QR z aplikacji desktopowej</Text>}
        {status === 'claiming' && <Text style={styles.hintText}>Parowanie…</Text>}
        {status === 'error' && (
          <View style={styles.errorBox}>
            <Text style={[styles.hintText, { color: '#ff6b6b', marginBottom: 10 }]}>{error}</Text>
            <Pressable onPress={retry} style={[styles.retryBtn, { backgroundColor: t.accent }]}>
              <Text style={{ color: t.accentFg, fontWeight: '600' }}>Spróbuj ponownie</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  hint: { position: 'absolute', bottom: 64, left: 0, right: 0, alignItems: 'center', paddingHorizontal: 24 },
  hintText: { color: '#fff', fontWeight: '600', textAlign: 'center' },
  errorBox: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.6)', padding: 16, borderRadius: 12 },
  retryBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10 },
});
