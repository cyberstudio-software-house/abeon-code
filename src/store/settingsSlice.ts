import type { StateCreator } from 'zustand';
import type { ThemeMode } from '../styles/theme';
import type { EffortLevel, CustomModel } from '../lib/models';
import { DEFAULT_MODEL_ID } from '../lib/models';

export type SettingsSlice = {
  theme: ThemeMode;
  leftWidth: number;
  rightWidth: number;
  displayName: string;
  defaultModelId: string;
  modelEfforts: Record<string, EffortLevel>;
  customModels: CustomModel[];
  skipPermissions: boolean;
  settingsOpen: boolean;

  setTheme: (t: ThemeMode) => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setDisplayName: (name: string) => void;
  setDefaultModel: (id: string) => void;
  setModelEffort: (modelId: string, effort: EffortLevel) => void;
  addCustomModel: (model: CustomModel) => void;
  removeCustomModel: (id: string) => void;
  setSkipPermissions: (v: boolean) => void;
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
  skipPermissions: false,
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
  setSkipPermissions: (skipPermissions) => set({ skipPermissions }),
  removeCustomModel: (id) => {
    const customModels = get().customModels.filter(m => m.id !== id);
    const defaultModelId = get().defaultModelId === id ? DEFAULT_MODEL_ID : get().defaultModelId;
    set({ customModels, defaultModelId });
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
});
