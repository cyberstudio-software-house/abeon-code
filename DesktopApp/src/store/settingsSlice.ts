import type { StateCreator } from 'zustand';
import type { ThemeMode } from '../styles/theme';
import type { ClaudeCustomModel } from '../lib/models';
import { DEFAULT_MODEL_ID, DEFAULT_TITLE_GEN_MODEL_ID } from '../lib/models';
import type { NotificationTrigger } from '../lib/attention';
import type { Provider, SupervisorLevel } from '../types';
import { DRAWER_DEFAULT_SIZE } from '../lib/drawerGeometry';
import type { SettingsCategoryId } from '../lib/settingsCategories';
import {
  TERMINAL_DEFAULTS, clampTerminalFontSize, isTerminalColors,
  type TerminalColors, type TerminalCursorStyle, type TerminalFontId, type TerminalLineHeight, type TerminalPaletteId,
} from '../lib/terminalAppearance';

export type SortMode = 'manual' | 'alpha' | 'activity';
export type HistoryViewMode = 'communication' | 'full';
export type SessionRestoreMode = 'ask' | 'always' | 'never';

export const isSessionRestoreMode = (value: unknown): value is SessionRestoreMode =>
  value === 'ask' || value === 'always' || value === 'never';

export const SUPERVISOR_LEVELS: readonly SupervisorLevel[] = ['off', 'relay', 'assistant', 'autonomous'];
export const SUPERVISOR_GRACE_RANGE = { min: 15, max: 300 } as const;
export const SUPERVISOR_PRESENCE_RANGE = { min: 1, max: 60 } as const;

export const isSupervisorLevel = (value: unknown): value is SupervisorLevel =>
  SUPERVISOR_LEVELS.includes(value as SupervisorLevel);

export const clampSupervisorGrace = (value: number) =>
  Math.max(SUPERVISOR_GRACE_RANGE.min, Math.min(SUPERVISOR_GRACE_RANGE.max, Math.round(value)));

export const clampSupervisorPresence = (value: number) =>
  Math.max(SUPERVISOR_PRESENCE_RANGE.min, Math.min(SUPERVISOR_PRESENCE_RANGE.max, Math.round(value)));

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
  sessionRestoreMode: SessionRestoreMode;
  terminalDrawerSize: number;
  terminalFontId: TerminalFontId;
  terminalFontSize: number;
  terminalLineHeight: TerminalLineHeight;
  terminalPaletteId: TerminalPaletteId;
  terminalCustomPalette: TerminalColors | null;
  terminalCursorStyle: TerminalCursorStyle;
  terminalCursorBlink: boolean;
  notificationsEnabled: boolean;
  notificationTrigger: NotificationTrigger;
  showActiveSessions: boolean;
  enabledProviders: Provider[];
  settingsOpen: boolean;
  settingsCategory: SettingsCategoryId;
  codexModelId: string;
  codexTitleGenModelId: string;
  codexCustomModels: string[];
  opencodeModelId: string;
  opencodeTitleGenModelId: string;
  opencodeCustomModels: string[];
  supervisorLevel: SupervisorLevel;
  supervisorGraceSeconds: number;
  supervisorPresenceMinutes: number;
  supervisorModelId: string;
  supervisorExtraRules: string[];
  supervisorDiscordEnabled: boolean;
  supervisorDiscordMuteWhenPresent: boolean;

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
  setSessionRestoreMode: (mode: SessionRestoreMode) => void;
  setTerminalDrawerSize: (size: number) => void;
  setTerminalFontId: (id: TerminalFontId) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalLineHeight: (lineHeight: TerminalLineHeight) => void;
  setTerminalPaletteId: (id: TerminalPaletteId) => void;
  setTerminalCustomPalette: (colors: TerminalColors) => void;
  setTerminalCursorStyle: (style: TerminalCursorStyle) => void;
  setTerminalCursorBlink: (blink: boolean) => void;
  resetTerminalAppearance: () => void;
  setNotificationsEnabled: (v: boolean) => void;
  setNotificationTrigger: (t: NotificationTrigger) => void;
  setShowActiveSessions: (v: boolean) => void;
  openSettings: (category?: SettingsCategoryId) => void;
  setSettingsCategory: (id: SettingsCategoryId) => void;
  closeSettings: () => void;
  setCodexModel: (modelId: string) => void;
  setCodexTitleGenModel: (modelId: string) => void;
  addCodexCustomModel: (modelId: string) => void;
  removeCodexCustomModel: (modelId: string) => void;
  setOpencodeModel: (modelId: string) => void;
  setOpencodeTitleGenModel: (modelId: string) => void;
  addOpencodeCustomModel: (modelId: string) => void;
  removeOpencodeCustomModel: (modelId: string) => void;
  setSupervisorLevel: (level: SupervisorLevel) => void;
  setSupervisorGraceSeconds: (seconds: number) => void;
  setSupervisorPresenceMinutes: (minutes: number) => void;
  setSupervisorModelId: (modelId: string) => void;
  setSupervisorExtraRules: (rules: string[]) => void;
  setSupervisorDiscordEnabled: (enabled: boolean) => void;
  setSupervisorDiscordMuteWhenPresent: (mute: boolean) => void;
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
  sessionRestoreMode: 'ask',
  terminalDrawerSize: DRAWER_DEFAULT_SIZE,
  terminalFontId: TERMINAL_DEFAULTS.fontId,
  terminalFontSize: TERMINAL_DEFAULTS.fontSize,
  terminalLineHeight: TERMINAL_DEFAULTS.lineHeight,
  terminalPaletteId: TERMINAL_DEFAULTS.paletteId,
  terminalCustomPalette: TERMINAL_DEFAULTS.customPalette,
  terminalCursorStyle: TERMINAL_DEFAULTS.cursorStyle,
  terminalCursorBlink: TERMINAL_DEFAULTS.cursorBlink,
  notificationsEnabled: true,
  notificationTrigger: 'both',
  showActiveSessions: true,
  enabledProviders: ['claude'],
  settingsOpen: false,
  settingsCategory: 'general',
  codexModelId: '',
  codexTitleGenModelId: '',
  codexCustomModels: [],
  opencodeModelId: '',
  opencodeTitleGenModelId: '',
  opencodeCustomModels: [],
  supervisorLevel: 'off',
  supervisorGraceSeconds: 60,
  supervisorPresenceMinutes: 5,
  supervisorModelId: '',
  supervisorExtraRules: [],
  supervisorDiscordEnabled: false,
  supervisorDiscordMuteWhenPresent: true,

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
  setSessionRestoreMode: (sessionRestoreMode) => set({ sessionRestoreMode }),
  setTerminalDrawerSize: (terminalDrawerSize) => set({ terminalDrawerSize }),
  setTerminalFontId: (terminalFontId) => set({ terminalFontId }),
  setTerminalFontSize: (size) => {
    if (!Number.isFinite(size)) return;
    set({ terminalFontSize: clampTerminalFontSize(size) });
  },
  setTerminalLineHeight: (terminalLineHeight) => set({ terminalLineHeight }),
  setTerminalPaletteId: (terminalPaletteId) => set({ terminalPaletteId }),
  setTerminalCustomPalette: (terminalCustomPalette) => {
    if (!isTerminalColors(terminalCustomPalette)) return;
    set({ terminalCustomPalette, terminalPaletteId: 'custom' });
  },
  setTerminalCursorStyle: (terminalCursorStyle) => set({ terminalCursorStyle }),
  setTerminalCursorBlink: (terminalCursorBlink) => set({ terminalCursorBlink }),
  resetTerminalAppearance: () => set({
    terminalFontId: TERMINAL_DEFAULTS.fontId,
    terminalFontSize: TERMINAL_DEFAULTS.fontSize,
    terminalLineHeight: TERMINAL_DEFAULTS.lineHeight,
    terminalPaletteId: TERMINAL_DEFAULTS.paletteId,
    terminalCustomPalette: TERMINAL_DEFAULTS.customPalette,
    terminalCursorStyle: TERMINAL_DEFAULTS.cursorStyle,
    terminalCursorBlink: TERMINAL_DEFAULTS.cursorBlink,
  }),
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
  openSettings: (category) => set(category ? { settingsOpen: true, settingsCategory: category } : { settingsOpen: true }),
  setSettingsCategory: (settingsCategory) => set({ settingsCategory }),
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
  setSupervisorLevel: (supervisorLevel) => set({ supervisorLevel }),
  setSupervisorGraceSeconds: (seconds) => {
    if (!Number.isFinite(seconds)) return;
    set({ supervisorGraceSeconds: clampSupervisorGrace(seconds) });
  },
  setSupervisorPresenceMinutes: (minutes) => {
    if (!Number.isFinite(minutes)) return;
    set({ supervisorPresenceMinutes: clampSupervisorPresence(minutes) });
  },
  setSupervisorModelId: (supervisorModelId) => set({ supervisorModelId }),
  setSupervisorExtraRules: (rules) => set({
    supervisorExtraRules: rules.map(rule => rule.trim()).filter(rule => rule !== ''),
  }),
  setSupervisorDiscordEnabled: (supervisorDiscordEnabled) => set({ supervisorDiscordEnabled }),
  setSupervisorDiscordMuteWhenPresent: (supervisorDiscordMuteWhenPresent) =>
    set({ supervisorDiscordMuteWhenPresent }),
});
