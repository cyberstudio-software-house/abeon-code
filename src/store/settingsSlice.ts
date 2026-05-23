import type { StateCreator } from 'zustand';
import type { ThemeMode } from '../styles/theme';
import type { EffortLevel, CustomModel } from '../lib/models';
import { DEFAULT_MODEL_ID } from '../lib/models';

export type SortMode = 'manual' | 'alpha' | 'activity';

export type SettingsSlice = {
  theme: ThemeMode;
  leftWidth: number;
  rightWidth: number;
  displayName: string;
  defaultModelId: string;
  modelEfforts: Record<string, EffortLevel>;
  customModels: CustomModel[];
  projectsBasePath: string;
  skipPermissions: boolean;
  sortMode: SortMode;
  settingsOpen: boolean;

  setTheme: (t: ThemeMode) => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setDisplayName: (name: string) => void;
  setDefaultModel: (id: string) => void;
  setModelEffort: (modelId: string, effort: EffortLevel) => void;
  addCustomModel: (model: CustomModel) => void;
  removeCustomModel: (id: string) => void;
  setProjectsBasePath: (path: string) => void;
  setSkipPermissions: (v: boolean) => void;
  setSortMode: (mode: SortMode) => void;
  openSettings: () => void;
  closeSettings: () => void;
};

export const createSettingsSlice: StateCreator<SettingsSlice> = (set, get) => ({
  theme: 'dark',
  leftWidth: 260,
  rightWidth: 300,
  displayName: '',
  defaultModelId: DEFAULT_MODEL_ID,
  modelEfforts: {},
  customModels: [],
  projectsBasePath: '',
  skipPermissions: false,
  sortMode: 'manual',
  settingsOpen: false,

  setTheme: (theme) => set({ theme }),
  setLeftWidth: (leftWidth) => set({ leftWidth }),
  setRightWidth: (rightWidth) => set({ rightWidth }),
  setDisplayName: (displayName) => set({ displayName }),
  setDefaultModel: (defaultModelId) => set({ defaultModelId }),
  setModelEffort: (modelId, effort) =>
    set({ modelEfforts: { ...get().modelEfforts, [modelId]: effort } }),
  addCustomModel: (model) =>
    set({ customModels: [...get().customModels, model] }),
  setProjectsBasePath: (projectsBasePath) => set({ projectsBasePath }),
  setSkipPermissions: (skipPermissions) => set({ skipPermissions }),
  setSortMode: (sortMode) => set({ sortMode }),
  removeCustomModel: (id) => {
    const customModels = get().customModels.filter(m => m.id !== id);
    const defaultModelId = get().defaultModelId === id ? DEFAULT_MODEL_ID : get().defaultModelId;
    set({ customModels, defaultModelId });
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
});
