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

type Persisted = {
  theme?: 'dark' | 'light' | 'system';
  leftWidth?: number;
  rightWidth?: number;
  displayName?: string;
  defaultModelId?: string;
  modelEfforts?: Record<string, string>;
  customModels?: Array<{ id: string; modelId: string; label: string }>;
  projectsBasePath?: string;
  skipPermissions?: boolean;
};

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const persisted = loadPersisted();
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
if (persisted.theme !== undefined) useStore.setState({ theme: persisted.theme });
if (typeof persisted.leftWidth === 'number') {
  useStore.setState({ leftWidth: clamp(persisted.leftWidth, 200, 420) });
}
if (typeof persisted.rightWidth === 'number') {
  useStore.setState({ rightWidth: clamp(persisted.rightWidth, 220, 480) });
}
if (persisted.displayName) useStore.setState({ displayName: persisted.displayName });
if (persisted.defaultModelId) useStore.setState({ defaultModelId: persisted.defaultModelId });
if (persisted.modelEfforts) useStore.setState({ modelEfforts: persisted.modelEfforts as Record<string, 'low' | 'medium' | 'high'> });
if (persisted.customModels) useStore.setState({ customModels: persisted.customModels });
if (persisted.projectsBasePath) useStore.setState({ projectsBasePath: persisted.projectsBasePath });
if (persisted.skipPermissions !== undefined) useStore.setState({ skipPermissions: persisted.skipPermissions });

useStore.subscribe((state) => {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      theme: state.theme,
      leftWidth: state.leftWidth,
      rightWidth: state.rightWidth,
      displayName: state.displayName,
      defaultModelId: state.defaultModelId,
      modelEfforts: state.modelEfforts,
      customModels: state.customModels,
      projectsBasePath: state.projectsBasePath,
      skipPermissions: state.skipPermissions,
    }));
  } catch {
    /* storage full or unavailable */
  }
});
