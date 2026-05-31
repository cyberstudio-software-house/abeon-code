// CloudService base URL. Overridable per-build via EXPO_PUBLIC_CLOUD_SERVICE_URL;
// defaults to the local dev service. The k8s URL is filled in once CloudService is deployed.
export const CLOUD_SERVICE_URL = process.env.EXPO_PUBLIC_CLOUD_SERVICE_URL ?? 'http://localhost:8080';
export const CENTRIFUGO_WS_URL =
  process.env.EXPO_PUBLIC_CENTRIFUGO_WS_URL ?? 'wss://ws.k8s.abeon.app/connection/websocket';
