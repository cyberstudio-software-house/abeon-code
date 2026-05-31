import { claimPairing, type PairClaim } from '@/src/lib/api';

// Desktop encodes the pairing code as `abeoncloud://pair?code=XXXX` (or a bare code).
// Codes are uppercase letters/digits and a dash, per the CloudService generator.
const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export function extractCode(payload: string): string | null {
  const m = payload.match(/[?&]code=([^&]+)/);
  const candidate = (m ? decodeURIComponent(m[1]) : payload).trim().toUpperCase();
  return CODE_RE.test(candidate) ? candidate : null;
}

export async function claimScannedCode(payload: string, onPaired: (c: PairClaim) => void): Promise<void> {
  const code = extractCode(payload);
  if (!code) return;
  onPaired(await claimPairing(code));
}
