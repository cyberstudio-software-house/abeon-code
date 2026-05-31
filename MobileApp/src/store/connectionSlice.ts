import type { StateCreator } from 'zustand';
import { fetchToken } from '@/src/lib/api';
import { createCentrifugo, type CentrifugoHandles } from '@/src/lib/centrifugo';
import { dispatchCommand } from '@/src/lib/dispatch';
import type { AuthSlice } from '@/src/store/authSlice';
import type { SessionsSlice } from '@/src/store/sessionsSlice';

export interface ConnectionSlice {
  connectionStatus: 'idle' | 'connecting' | 'connected' | 'disconnected';
  handles: CentrifugoHandles | null;
  connect: () => void;
  disconnect: () => void;
}

type Deps = AuthSlice & SessionsSlice & ConnectionSlice;

export const createConnectionSlice: StateCreator<Deps, [], [], ConnectionSlice> = (set, get) => ({
  connectionStatus: 'idle',
  handles: null,
  connect: () => {
    const { phoneToken, deviceId, handles } = get();
    if (!phoneToken || !deviceId || handles) return;
    const getToken = async () => (await fetchToken(phoneToken)).token;
    const h = createCentrifugo(getToken);
    // Desktop offline at connect → command 409 (presence gate). The spec treats this
    // as routine: keep the (history-backfilled) list and re-request on the next
    // `connected`. Swallow the rejection so it isn't an unhandled-promise warning.
    const requestRoster = () => { dispatchCommand(phoneToken, { type: 'requestRoster' }).catch(() => {}); };
    h.client.on('connecting', () => set({ connectionStatus: 'connecting' }));
    h.client.on('connected', () => { set({ connectionStatus: 'connected' }); requestRoster(); });
    h.client.on('disconnected', () => set({ connectionStatus: 'disconnected' }));
    h.subscribeDevice(
      deviceId,
      () => { /* cmdResult acks; wired to UI feedback later */ },
      (e) => get().applySessionEvent(e),
    );
    set({ handles: h, connectionStatus: 'connecting' });
  },
  disconnect: () => {
    get().handles?.disconnect();
    set({ handles: null, connectionStatus: 'disconnected' });
  },
});
