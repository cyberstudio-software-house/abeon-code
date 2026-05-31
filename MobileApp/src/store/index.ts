import { createStore as createVanilla, type StoreApi } from 'zustand/vanilla';
import { create } from 'zustand';
import { createAuthSlice, type AuthSlice } from '@/src/store/authSlice';

export type AppState = AuthSlice;

// Factory for tests (isolated vanilla store per test; `.getState()` access).
export function createStore(): StoreApi<AppState> {
  return createVanilla<AppState>()((...a) => ({ ...createAuthSlice(...a) }));
}

// Singleton hook for the app.
export const useStore = create<AppState>()((...a) => ({ ...createAuthSlice(...a) }));
