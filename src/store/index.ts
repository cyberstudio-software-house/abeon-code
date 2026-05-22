import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSettingsSlice, type SettingsSlice } from './settingsSlice';
import { createProjectsSlice, type ProjectsSlice } from './projectsSlice';
import { createSessionsSlice, type SessionsSlice } from './sessionsSlice';
import { createTabsSlice, type TabsSlice } from './tabsSlice';

export type AppState = SettingsSlice & ProjectsSlice & SessionsSlice & TabsSlice;

export const useStore = create<AppState>()(
  persist(
    (...a) => ({
      ...createSettingsSlice(...a),
      ...createProjectsSlice(...a),
      ...createSessionsSlice(...a),
      ...createTabsSlice(...a),
    }),
    {
      name: 'abeoncode.store',
      partialize: (s) => ({ theme: s.theme, leftWidth: s.leftWidth, rightWidth: s.rightWidth }),
    }
  )
);
