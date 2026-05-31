import { getCloudServiceUrl } from '@/src/lib/config';
import type { RemoteEnvelope } from '@/src/types/RemoteEnvelope';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${getCloudServiceUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface PairClaim { phoneToken: string; deviceId: string; }
export interface TokenResponse { token: string; expiresInSecs: number; }

export function claimPairing(code: string): Promise<PairClaim> {
  return request('/v1/pair/claim', { method: 'POST', body: JSON.stringify({ code }) });
}
export function fetchToken(phoneToken: string): Promise<TokenResponse> {
  return request('/v1/token', { method: 'POST', headers: { Authorization: `Bearer ${phoneToken}` } });
}
export function sendCommand(phoneToken: string, envelope: RemoteEnvelope): Promise<{ published: boolean }> {
  return request('/v1/command', {
    method: 'POST',
    headers: { Authorization: `Bearer ${phoneToken}` },
    body: JSON.stringify(envelope),
  });
}
export function registerPushToken(phoneToken: string, expoToken: string): Promise<unknown> {
  return request('/v1/push-token', {
    method: 'POST',
    headers: { Authorization: `Bearer ${phoneToken}` },
    body: JSON.stringify({ expoToken }),
  });
}
