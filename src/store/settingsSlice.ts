import type { StateCreator } from 'zustand';
import type { ThemeMode } from '../styles/theme';

export type SettingsSlice = {
  theme: ThemeMode;
  leftWidth: number;
  rightWidth: number;
  setTheme: (t: ThemeMode) => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
};

export const createSettingsSlice: StateCreator<SettingsSlice> = (set) => ({
  theme: 'dark',
  leftWidth: 260,
  rightWidth: 300,
  setTheme: (theme) => set({ theme }),
  setLeftWidth: (leftWidth) => set({ leftWidth }),
  setRightWidth: (rightWidth) => set({ rightWidth }),
});
