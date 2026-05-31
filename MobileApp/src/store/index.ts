import { createStore as createVanilla, type StoreApi } from 'zustand/vanilla';
import { create, type StateCreator } from 'zustand';
import { createAuthSlice, type AuthSlice } from '@/src/store/authSlice';
import { createSessionsSlice, type SessionsSlice } from '@/src/store/sessionsSlice';
import { createConnectionSlice, type ConnectionSlice } from '@/src/store/connectionSlice';

export type AppState = AuthSlice & SessionsSlice & ConnectionSlice;

// Each slice creator is typed over its own narrower state type. To spread all three into a
// single combined StateCreator<AppState> we must widen via unknown — the standard Zustand
// slice-composition pattern when generics don't overlap.
type AppCreator = StateCreator<AppState, [], [], AppState>;

const toApp = <T>(c: StateCreator<T, [], [], T>): AppCreator =>
  c as unknown as AppCreator;

const combined: AppCreator = (...a) => ({
  ...toApp(createAuthSlice)(...a),
  ...toApp(createSessionsSlice)(...a),
  ...(createConnectionSlice as AppCreator)(...a),
});

// Factory for tests (isolated vanilla store per test; `.getState()` access).
export function createStore(): StoreApi<AppState> {
  return createVanilla<AppState>()(combined);
}

// Singleton hook for the app.
export const useStore = create<AppState>()(combined);
