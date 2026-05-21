import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSettingsSlice, type SettingsSlice } from './settingsSlice';

export type AppState = SettingsSlice;

export const useStore = create<AppState>()(
  persist(
    (...a) => ({ ...createSettingsSlice(...a) }),
    {
      name: 'abeoncode.store',
      partialize: (s) => ({ theme: s.theme, leftWidth: s.leftWidth, rightWidth: s.rightWidth }),
    }
  )
);
