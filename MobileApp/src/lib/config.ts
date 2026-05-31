// CloudService base URL. Initial value comes from EXPO_PUBLIC_CLOUD_SERVICE_URL (build
// time) or the local-dev default; at runtime it can be overridden in Settings and is
// persisted (a physical phone can't reach the dev machine via localhost, so the URL must
// be set to the machine's LAN address, e.g. http://192.168.0.174:18080).
let cloudServiceUrl = process.env.EXPO_PUBLIC_CLOUD_SERVICE_URL ?? 'http://localhost:8080';

export function getCloudServiceUrl(): string {
  return cloudServiceUrl;
}

export function setCloudServiceUrl(url: string): void {
  const trimmed = url.trim();
  if (trimmed) cloudServiceUrl = trimmed.replace(/\/+$/, '');
}

export const CENTRIFUGO_WS_URL =
  process.env.EXPO_PUBLIC_CENTRIFUGO_WS_URL ?? 'wss://ws.k8s.abeon.app/connection/websocket';
