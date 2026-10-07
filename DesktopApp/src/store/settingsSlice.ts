import type { StateCreator } from 'zustand';
import type { ThemeMode } from '../styles/theme';
import type { ClaudeCustomModel } from '../lib/models';
import { DEFAULT_MODEL_ID, DEFAULT_TITLE_GEN_MODEL_ID } from '../lib/models';
import type { NotificationTrigger } from '../lib/attention';
import type { Provider } from '../types';
import { DRAWER_DEFAULT_SIZE } from '../lib/drawerGeometry';

export type SortMode = 'manual' | 'alpha' | 'activity';
export type HistoryViewMode = 'communication' | 'full';
export type TabLayoutMode = 'classic' | 'stacked';
export type SessionRestoreMode = 'ask' | 'always' | 'never';

export const isSessionRestoreMode = (value: unknown): value is SessionRestoreMode =>
  value === 'ask' || value === 'always' || value === 'never';

export type SettingsSlice = {
  theme: ThemeMode;
  leftWidth: number;
  rightWidth: number;
  displayName: string;
  defaultModelId: string;
  titleGenModelId: string;
  modelEfforts: Record<string, string>;
  customModels: ClaudeCustomModel[];
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
  tabLayoutMode: TabLayoutMode;
  sessionRestoreMode: SessionRestoreMode;
  terminalDrawerSize: number;
  notificationsEnabled: boolean;
  notificationTrigger: NotificationTrigger;
  showActiveSessions: boolean;
  enabledProviders: Provider[];
  settingsOpen: boolean;
  codexModelId: string;
  codexTitleGenModelId: string;
  codexCustomModels: string[];
  opencodeModelId: string;
  opencodeTitleGenModelId: string;
  opencodeCustomModels: string[];

  toggleProvider: (p: Provider) => void;
  setTheme: (t: ThemeMode) => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setDisplayName: (name: string) => void;
  setDefaultModel: (id: string) => void;
  setTitleGenModel: (id: string) => void;
  setModelEffort: (modelId: string, effort: string | null) => void;
  addCustomModel: (model: ClaudeCustomModel) => void;
  removeCustomModel: (modelId: string) => void;
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
  setTabLayoutMode: (mode: TabLayoutMode) => void;
  setSessionRestoreMode: (mode: SessionRestoreMode) => void;
  setTerminalDrawerSize: (size: number) => void;
  setNotificationsEnabled: (v: boolean) => void;
  setNotificationTrigger: (t: NotificationTrigger) => void;
  setShowActiveSessions: (v: boolean) => void;
  openSettings: () => void;
  closeSettings: () => void;
  setCodexModel: (modelId: string) => void;
  setCodexTitleGenModel: (modelId: string) => void;
  addCodexCustomModel: (modelId: string) => void;
  removeCodexCustomModel: (modelId: string) => void;
  setOpencodeModel: (modelId: string) => void;
  setOpencodeTitleGenModel: (modelId: string) => void;
  addOpencodeCustomModel: (modelId: string) => void;
  removeOpencodeCustomModel: (modelId: string) => void;
};

export const createSettingsSlice: StateCreator<SettingsSlice> = (set, get) => ({
  theme: 'dark',
  leftWidth: 260,
  rightWidth: 300,
  displayName: '',
  defaultModelId: DEFAULT_MODEL_ID,
  titleGenModelId: DEFAULT_TITLE_GEN_MODEL_ID,
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
  tabLayoutMode: 'classic',
  sessionRestoreMode: 'ask',
  terminalDrawerSize: DRAWER_DEFAULT_SIZE,
  notificationsEnabled: true,
  notificationTrigger: 'both',
  showActiveSessions: true,
  enabledProviders: ['claude'],
  settingsOpen: false,
  codexModelId: '',
  codexTitleGenModelId: '',
  codexCustomModels: [],
  opencodeModelId: '',
  opencodeTitleGenModelId: '',
  opencodeCustomModels: [],

  toggleProvider: (p) => {
    const cur = get().enabledProviders;
    const next = cur.includes(p) ? cur.filter(x => x !== p) : [...cur, p];
    if (next.length === 0) return;
    set({ enabledProviders: next });
  },
  setTheme: (theme) => set({ theme }),
  setLeftWidth: (leftWidth) => set({ leftWidth }),
  setRightWidth: (rightWidth) => set({ rightWidth }),
  setDisplayName: (displayName) => set({ displayName }),
  setDefaultModel: (defaultModelId) => set({ defaultModelId }),
  setTitleGenModel: (titleGenModelId) => set({ titleGenModelId }),
  setModelEffort: (modelId, effort) => {
    const { [modelId]: _removed, ...rest } = get().modelEfforts;
    set({ modelEfforts: effort ? { ...rest, [modelId]: effort } : rest });
  },
  addCustomModel: (model) => {
    const modelId = model.modelId.trim();
    const label = model.label.trim();
    if (!modelId || !label || get().customModels.some(m => m.modelId === modelId)) return;
    set({ customModels: [...get().customModels, { modelId, label }] });
  },
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
  setTabLayoutMode: (tabLayoutMode) => set({ tabLayoutMode }),
  setSessionRestoreMode: (sessionRestoreMode) => set({ sessionRestoreMode }),
  setTerminalDrawerSize: (terminalDrawerSize) => set({ terminalDrawerSize }),
  setNotificationsEnabled: (notificationsEnabled) => set({ notificationsEnabled }),
  setNotificationTrigger: (notificationTrigger) => set({ notificationTrigger }),
  setShowActiveSessions: (showActiveSessions) => set({ showActiveSessions }),
  removeCustomModel: (modelId) => {
    const { [modelId]: _removed, ...modelEfforts } = get().modelEfforts;
    set({
      customModels: get().customModels.filter(m => m.modelId !== modelId),
      modelEfforts,
      ...(get().defaultModelId === modelId ? { defaultModelId: DEFAULT_MODEL_ID } : {}),
      ...(get().titleGenModelId === modelId ? { titleGenModelId: DEFAULT_TITLE_GEN_MODEL_ID } : {}),
    });
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  setCodexModel: (codexModelId) => set({ codexModelId }),
  setCodexTitleGenModel: (codexTitleGenModelId) => set({ codexTitleGenModelId }),
  addCodexCustomModel: (modelId) => {
    const trimmed = modelId.trim();
    if (!trimmed || get().codexCustomModels.includes(trimmed)) return;
    set({ codexCustomModels: [...get().codexCustomModels, trimmed] });
  },
  removeCodexCustomModel: (modelId) => {
    set({
      codexCustomModels: get().codexCustomModels.filter(m => m !== modelId),
      ...(get().codexModelId === modelId ? { codexModelId: '' } : {}),
      ...(get().codexTitleGenModelId === modelId ? { codexTitleGenModelId: '' } : {}),
    });
  },
  setOpencodeModel: (opencodeModelId) => set({ opencodeModelId }),
  setOpencodeTitleGenModel: (opencodeTitleGenModelId) => set({ opencodeTitleGenModelId }),
  addOpencodeCustomModel: (modelId) => {
    const trimmed = modelId.trim();
    if (!trimmed || get().opencodeCustomModels.includes(trimmed)) return;
    set({ opencodeCustomModels: [...get().opencodeCustomModels, trimmed] });
  },
  removeOpencodeCustomModel: (modelId) => {
    set({
      opencodeCustomModels: get().opencodeCustomModels.filter(model => model !== modelId),
      ...(get().opencodeModelId === modelId ? { opencodeModelId: '' } : {}),
      ...(get().opencodeTitleGenModelId === modelId ? { opencodeTitleGenModelId: '' } : {}),
    });
  },
});
