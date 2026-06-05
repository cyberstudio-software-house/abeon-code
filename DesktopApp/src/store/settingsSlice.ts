import type { StateCreator } from 'zustand';
import type { ThemeMode } from '../styles/theme';
import type { EffortLevel, CustomModel } from '../lib/models';
import { DEFAULT_MODEL_ID } from '../lib/models';
import type { NotificationTrigger } from '../lib/attention';

export type SortMode = 'manual' | 'alpha' | 'activity';
export type HistoryViewMode = 'communication' | 'full';

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
  remoteBridgeEnabled: boolean;
  allowRemoteSpawn: boolean;
  cloudServiceUrl: string;
  sortMode: SortMode;
  shellPath: string;
  editorPath: string;
  shortcutOverrides: Record<string, string>;
  historyViewMode: HistoryViewMode;
  notificationsEnabled: boolean;
  notificationTrigger: NotificationTrigger;
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
  setRemoteBridgeEnabled: (v: boolean) => void;
  setAllowRemoteSpawn: (v: boolean) => void;
  setCloudServiceUrl: (url: string) => void;
  setSortMode: (mode: SortMode) => void;
  setShellPath: (path: string) => void;
  setEditorPath: (path: string) => void;
  setShortcutOverride: (id: string, binding: string) => void;
  resetShortcutOverrides: () => void;
  setHistoryViewMode: (mode: HistoryViewMode) => void;
  setNotificationsEnabled: (v: boolean) => void;
  setNotificationTrigger: (t: NotificationTrigger) => void;
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
  remoteBridgeEnabled: false,
  allowRemoteSpawn: false,
  cloudServiceUrl: '',
  sortMode: 'manual',
  shellPath: '',
  editorPath: '',
  shortcutOverrides: {},
  historyViewMode: 'full',
  notificationsEnabled: true,
  notificationTrigger: 'both',
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
  setRemoteBridgeEnabled: (remoteBridgeEnabled) => set({ remoteBridgeEnabled }),
  setAllowRemoteSpawn: (allowRemoteSpawn) => set({ allowRemoteSpawn }),
  setCloudServiceUrl: (cloudServiceUrl) => set({ cloudServiceUrl }),
  setSortMode: (sortMode) => set({ sortMode }),
  setShellPath: (shellPath) => set({ shellPath }),
  setEditorPath: (editorPath) => set({ editorPath }),
  setShortcutOverride: (id, binding) =>
    set({ shortcutOverrides: { ...get().shortcutOverrides, [id]: binding } }),
  resetShortcutOverrides: () => set({ shortcutOverrides: {} }),
  setHistoryViewMode: (historyViewMode) => set({ historyViewMode }),
  setNotificationsEnabled: (notificationsEnabled) => set({ notificationsEnabled }),
  setNotificationTrigger: (notificationTrigger) => set({ notificationTrigger }),
  removeCustomModel: (id) => {
    const customModels = get().customModels.filter(m => m.id !== id);
    const defaultModelId = get().defaultModelId === id ? DEFAULT_MODEL_ID : get().defaultModelId;
    const titleGenModelId = get().titleGenModelId === id ? 'haiku-4.5' : get().titleGenModelId;
    set({ customModels, defaultModelId, titleGenModelId });
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
});
