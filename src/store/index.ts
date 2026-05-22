import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSettingsSlice, type SettingsSlice } from './settingsSlice';
import { createProjectsSlice, type ProjectsSlice } from './projectsSlice';
import { createSessionsSlice, type SessionsSlice } from './sessionsSlice';
import { createTabsSlice, type TabsSlice } from './tabsSlice';
import { createActionsSlice, type ActionsSlice } from './actionsSlice';
import { createGitSlice, type GitSlice } from './gitSlice';

export type AppState = SettingsSlice & ProjectsSlice & SessionsSlice & TabsSlice & ActionsSlice & GitSlice;

export const useStore = create<AppState>()(
  persist(
    (...a) => ({
      ...createSettingsSlice(...a),
      ...createProjectsSlice(...a),
      ...createSessionsSlice(...a),
      ...createTabsSlice(...a),
      ...createActionsSlice(...a),
      ...createGitSlice(...a),
    }),
    {
      name: 'abeoncode.store',
      partialize: (s) => ({ theme: s.theme, leftWidth: s.leftWidth, rightWidth: s.rightWidth }),
    }
  )
);
