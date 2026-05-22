import { create } from 'zustand';
import { createSettingsSlice, type SettingsSlice } from './settingsSlice';
import { createProjectsSlice, type ProjectsSlice } from './projectsSlice';
import { createSessionsSlice, type SessionsSlice } from './sessionsSlice';
import { createTabsSlice, type TabsSlice } from './tabsSlice';
import { createActionsSlice, type ActionsSlice } from './actionsSlice';
import { createGitSlice, type GitSlice } from './gitSlice';

export type AppState = SettingsSlice & ProjectsSlice & SessionsSlice & TabsSlice & ActionsSlice & GitSlice;

export const useStore = create<AppState>()((...a) => ({
  ...createSettingsSlice(...a),
  ...createProjectsSlice(...a),
  ...createSessionsSlice(...a),
  ...createTabsSlice(...a),
  ...createActionsSlice(...a),
  ...createGitSlice(...a),
}));

const PERSIST_KEY = 'abeoncode.settings';

type Persisted = { theme?: 'dark' | 'light' | 'system'; leftWidth?: number; rightWidth?: number };

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const persisted = loadPersisted();
if (persisted.theme !== undefined) useStore.setState({ theme: persisted.theme });
if (persisted.leftWidth !== undefined) useStore.setState({ leftWidth: persisted.leftWidth });
if (persisted.rightWidth !== undefined) useStore.setState({ rightWidth: persisted.rightWidth });

useStore.subscribe((state) => {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      theme: state.theme,
      leftWidth: state.leftWidth,
      rightWidth: state.rightWidth,
    }));
  } catch {
    /* storage full or unavailable */
  }
});
