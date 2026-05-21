import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSettingsSlice, type SettingsSlice } from './settingsSlice';
import { createProjectsSlice, type ProjectsSlice } from './projectsSlice';

export type AppState = SettingsSlice & ProjectsSlice;

export const useStore = create<AppState>()(
  persist(
    (...a) => ({ ...createSettingsSlice(...a), ...createProjectsSlice(...a) }),
    {
      name: 'abeoncode.store',
      partialize: (s) => ({ theme: s.theme, leftWidth: s.leftWidth, rightWidth: s.rightWidth }),
    }
  )
);
