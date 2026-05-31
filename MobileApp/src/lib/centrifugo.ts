import { Centrifuge, type Subscription } from 'centrifuge';
import { CENTRIFUGO_WS_URL } from '@/src/lib/config';
import type { SessionEvent } from '@/src/types/SessionEvent';
import type { RemoteEvent } from '@/src/types/RemoteEvent';

const SESSION_TYPES = new Set(['sessionAppend', 'sessionActivity', 'sessionTitle', 'sessionUsage', 'sessionRoster']);

export function parseSessionEvent(data: unknown): SessionEvent | null {
  if (data && typeof data === 'object' && SESSION_TYPES.has((data as { type?: string }).type ?? '')) {
    return data as SessionEvent;
  }
  return null;
}

export function parseDeviceEvent(data: unknown): RemoteEvent | null {
  if (data && typeof data === 'object' && (data as { type?: string }).type === 'cmdResult') {
    return data as RemoteEvent;
  }
  return null;
}

export interface CentrifugoHandles {
  client: Centrifuge;
  subscribeSession: (sessionId: string, onEvent: (e: SessionEvent) => void) => Subscription;
  subscribeDevice: (
    deviceId: string,
    onCmdResult: (e: RemoteEvent) => void,
    onSessionEvent: (e: SessionEvent) => void,
  ) => Subscription;
  disconnect: () => void;
}

export function applyHistoryPage(
  publications: Array<{ data?: unknown }>,
  onEvent: (e: SessionEvent) => void,
): void {
  for (const pub of publications) {
    const e = parseSessionEvent(pub?.data);
    if (e) onEvent(e);
  }
}

// getToken is called by centrifuge whenever it needs a (fresh) connection JWT.
export function createCentrifugo(getToken: () => Promise<string>): CentrifugoHandles {
  const client = new Centrifuge(CENTRIFUGO_WS_URL, { getToken: async () => getToken() });
  const subscribeSession = (sessionId: string, onEvent: (e: SessionEvent) => void) => {
    const sub = client.newSubscription(`abeon-cloud-sess:${sessionId}`);
    sub.on('subscribed', (ctx) => {
      if (!ctx.recovered) {
        sub.history({ limit: 100 }).then((r) => applyHistoryPage(r.publications, onEvent)).catch(() => {});
      }
    });
    sub.on('publication', (ctx) => { const e = parseSessionEvent(ctx.data); if (e) onEvent(e); });
    sub.subscribe();
    return sub;
  };
  const subscribeDevice = (
    deviceId: string,
    onCmdResult: (e: RemoteEvent) => void,
    onSessionEvent: (e: SessionEvent) => void,
  ) => {
    const sub = client.newSubscription(`abeon-cloud-dev:${deviceId}`);
    const route = (data: unknown) => {
      const cmd = parseDeviceEvent(data);
      if (cmd) { onCmdResult(cmd); return; }
      const se = parseSessionEvent(data);
      if (se) onSessionEvent(se);
    };
    sub.on('subscribed', (ctx) => {
      if (!ctx.recovered) {
        sub.history({ limit: 100 }).then((r) => { for (const p of r.publications) route(p.data); }).catch(() => {});
      }
    });
    sub.on('publication', (ctx) => route(ctx.data));
    sub.subscribe();
    return sub;
  };
  client.connect();
  return { client, subscribeSession, subscribeDevice, disconnect: () => client.disconnect() };
}
