import type { StateCreator } from 'zustand';
import { saveCredentials, loadCredentials, clearCredentials, type Credentials } from '@/src/lib/secure';

export interface AuthSlice {
  status: 'unpaired' | 'paired';
  phoneToken: string | null;
  deviceId: string | null;
  pair: (c: Credentials) => Promise<void>;
  unpair: () => Promise<void>;
  hydrate: () => Promise<void>;
}

export const createAuthSlice: StateCreator<AuthSlice, [], [], AuthSlice> = (set) => ({
  status: 'unpaired',
  phoneToken: null,
  deviceId: null,
  pair: async (c) => { await saveCredentials(c); set({ status: 'paired', phoneToken: c.phoneToken, deviceId: c.deviceId }); },
  unpair: async () => { await clearCredentials(); set({ status: 'unpaired', phoneToken: null, deviceId: null }); },
  hydrate: async () => {
    const c = await loadCredentials();
    if (c) set({ status: 'paired', phoneToken: c.phoneToken, deviceId: c.deviceId });
  },
});
