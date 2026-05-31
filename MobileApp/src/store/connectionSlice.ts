import type { StateCreator } from 'zustand';
import { fetchToken } from '@/src/lib/api';
import { createCentrifugo, type CentrifugoHandles } from '@/src/lib/centrifugo';
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
    h.subscribeDevice(deviceId, () => { /* cmdResult acks; wired to UI feedback later */ });
    set({ handles: h, connectionStatus: 'connecting' });
  },
  disconnect: () => {
    get().handles?.disconnect();
    set({ handles: null, connectionStatus: 'disconnected' });
  },
});
