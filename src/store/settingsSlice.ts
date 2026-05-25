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
  titleGenModelId: string;
  modelEfforts: Record<string, EffortLevel>;
  customModels: CustomModel[];
  projectsBasePath: string;
  skipPermissions: boolean;
  sortMode: SortMode;
  shellPath: string;
  settingsOpen: boolean;

  setTheme: (t: ThemeMode) => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setDisplayName: (name: string) => void;
  setDefaultModel: (id: string) => void;
  setTitleGenModel: (id: string) => void;
  setModelEffort: (modelId: string, effort: EffortLevel) => void;
  addCustomModel: (model: CustomModel) => void;
  removeCustomModel: (id: string) => void;
  setProjectsBasePath: (path: string) => void;
  setSkipPermissions: (v: boolean) => void;
  setSortMode: (mode: SortMode) => void;
  setShellPath: (path: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
};

export const createSettingsSlice: StateCreator<SettingsSlice> = (set, get) => ({
  theme: 'dark',
  leftWidth: 260,
  rightWidth: 300,
  displayName: '',
  defaultModelId: DEFAULT_MODEL_ID,
  titleGenModelId: 'haiku-4.5',
  modelEfforts: {},
  customModels: [],
  projectsBasePath: '',
  skipPermissions: false,
  sortMode: 'manual',
  shellPath: '',
  settingsOpen: false,

  setTheme: (theme) => set({ theme }),
  setLeftWidth: (leftWidth) => set({ leftWidth }),
  setRightWidth: (rightWidth) => set({ rightWidth }),
  setDisplayName: (displayName) => set({ displayName }),
  setDefaultModel: (defaultModelId) => set({ defaultModelId }),
  setTitleGenModel: (titleGenModelId) => set({ titleGenModelId }),
  setModelEffort: (modelId, effort) =>
    set({ modelEfforts: { ...get().modelEfforts, [modelId]: effort } }),
  addCustomModel: (model) =>
    set({ customModels: [...get().customModels, model] }),
  setProjectsBasePath: (projectsBasePath) => set({ projectsBasePath }),
  setSkipPermissions: (skipPermissions) => set({ skipPermissions }),
  setSortMode: (sortMode) => set({ sortMode }),
  setShellPath: (shellPath) => set({ shellPath }),
  removeCustomModel: (id) => {
    const customModels = get().customModels.filter(m => m.id !== id);
    const defaultModelId = get().defaultModelId === id ? DEFAULT_MODEL_ID : get().defaultModelId;
    const titleGenModelId = get().titleGenModelId === id ? 'haiku-4.5' : get().titleGenModelId;
    set({ customModels, defaultModelId, titleGenModelId });
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
});
