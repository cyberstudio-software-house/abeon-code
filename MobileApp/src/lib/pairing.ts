import { claimPairing, type PairClaim } from '@/src/lib/api';

// Desktop encodes the pairing code in the QR (bare code, or `abeoncloud://pair?code=…`).
// CloudService `generate_pairing_code` emits 8 chars from a no-ambiguous alphabet
// (23456789 + A–Z minus I/L/O), no dash. Match exactly that.
const CODE_RE = /^[2-9A-HJKMNP-Z]{8}$/;

export function extractCode(payload: string): string | null {
  const m = payload.match(/[?&]code=([^&]+)/);
  const candidate = (m ? decodeURIComponent(m[1]) : payload).trim().toUpperCase();
  return CODE_RE.test(candidate) ? candidate : null;
}

// Returns true if the payload held a valid code and a claim was made, false if the
// payload was ignored. The caller uses this to re-arm a scanner that would otherwise
// stay disarmed after scanning an unrelated QR.
export async function claimScannedCode(payload: string, onPaired: (c: PairClaim) => void): Promise<boolean> {
  const code = extractCode(payload);
  if (!code) return false;
  onPaired(await claimPairing(code));
  return true;
}
