import { create } from 'zustand';
import { createSettingsSlice, type SettingsSlice } from './settingsSlice';
import { createProjectsSlice, type ProjectsSlice } from './projectsSlice';
import { createSessionsSlice, type SessionsSlice } from './sessionsSlice';
import { createTabsSlice, type TabsSlice } from './tabsSlice';
import { createActionsSlice, type ActionsSlice } from './actionsSlice';
import { createGitSlice, type GitSlice } from './gitSlice';
import { tauri } from '../lib/tauri';

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
const TABS_PERSIST_KEY = 'abeoncode.tabs';

type EffortLevelStr = 'low' | 'medium' | 'high';
type CustomModelLite = { id: string; modelId: string; label: string };

type Persisted = {
  theme?: 'dark' | 'light' | 'system';
  leftWidth?: number;
  rightWidth?: number;
  displayName?: string;
  defaultModelId?: string;
  titleGenModelId?: string;
  modelEfforts?: Record<string, EffortLevelStr>;
  customModels?: CustomModelLite[];
  projectsBasePath?: string;
  skipPermissions?: boolean;
  sortMode?: 'manual' | 'alpha' | 'activity';
  shellPath?: string;
  shortcutOverrides?: Record<string, string>;
  historyViewMode?: 'communication' | 'full';
};

const PERSISTED_KEYS = [
  'theme', 'leftWidth', 'rightWidth', 'displayName',
  'defaultModelId', 'titleGenModelId', 'modelEfforts', 'customModels',
  'projectsBasePath', 'skipPermissions',
  'sortMode',
  'shellPath',
  'shortcutOverrides',
  'historyViewMode',
] as const satisfies readonly (keyof Persisted)[];

type PersistedKey = typeof PERSISTED_KEYS[number];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function pickPersistedFields(state: AppState): Persisted {
  return {
    theme: state.theme,
    leftWidth: state.leftWidth,
    rightWidth: state.rightWidth,
    displayName: state.displayName,
    defaultModelId: state.defaultModelId,
    titleGenModelId: state.titleGenModelId,
    modelEfforts: state.modelEfforts as Record<string, EffortLevelStr>,
    customModels: state.customModels,
    projectsBasePath: state.projectsBasePath,
    skipPermissions: state.skipPermissions,
    sortMode: state.sortMode,
    shellPath: state.shellPath,
    shortcutOverrides: state.shortcutOverrides,
    historyViewMode: state.historyViewMode,
  };
}

function serializeValue(key: PersistedKey, value: unknown): string {
  if (value === undefined || value === null) return '';
  switch (key) {
    case 'leftWidth':
    case 'rightWidth':
      return String(value as number);
    case 'skipPermissions':
      return value ? 'true' : 'false';
    case 'modelEfforts':
    case 'customModels':
    case 'shortcutOverrides':
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

function deserializeValue(key: PersistedKey, raw: string): unknown {
  if (raw === '') return undefined;
  switch (key) {
    case 'leftWidth':
      return clamp(Number(raw), 200, 420);
    case 'rightWidth':
      return clamp(Number(raw), 220, 480);
    case 'skipPermissions':
      return raw === 'true';
    case 'modelEfforts':
    case 'customModels':
    case 'shortcutOverrides':
      try { return JSON.parse(raw); } catch { return undefined; }
    default:
      return raw;
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v as object).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}';
}

function diffKeys(prev: Persisted, next: Persisted): PersistedKey[] {
  return PERSISTED_KEYS.filter(k => stableStringify(prev[k]) !== stableStringify(next[k]));
}

function applyPersistedToState(p: Persisted) {
  const patch: Partial<AppState> = {};
  if (p.theme !== undefined) patch.theme = p.theme;
  if (typeof p.leftWidth === 'number') patch.leftWidth = clamp(p.leftWidth, 200, 420);
  if (typeof p.rightWidth === 'number') patch.rightWidth = clamp(p.rightWidth, 220, 480);
  if (p.displayName) patch.displayName = p.displayName;
  if (p.defaultModelId) patch.defaultModelId = p.defaultModelId;
  if (p.titleGenModelId) patch.titleGenModelId = p.titleGenModelId;
  if (p.modelEfforts) patch.modelEfforts = p.modelEfforts as AppState['modelEfforts'];
  if (p.customModels) patch.customModels = p.customModels as AppState['customModels'];
  if (p.projectsBasePath) patch.projectsBasePath = p.projectsBasePath;
  if (p.skipPermissions !== undefined) patch.skipPermissions = p.skipPermissions;
  if (p.sortMode === 'manual' || p.sortMode === 'alpha' || p.sortMode === 'activity') {
    patch.sortMode = p.sortMode;
  }
  if (typeof p.shellPath === 'string') patch.shellPath = p.shellPath;
  if (p.shortcutOverrides && typeof p.shortcutOverrides === 'object') {
    patch.shortcutOverrides = p.shortcutOverrides as Record<string, string>;
  }
  if (p.historyViewMode === 'communication' || p.historyViewMode === 'full') {
    patch.historyViewMode = p.historyViewMode;
  }
  if (Object.keys(patch).length > 0) useStore.setState(patch);
}

function loadFromLocalStorage(): Persisted {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    return raw ? JSON.parse(raw) as Persisted : {};
  } catch {
    return {};
  }
}

function writeLocalStorage(snapshot: Persisted) {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(snapshot));
  } catch {
    /* storage full or unavailable */
  }
}

// --- Tab persistence (localStorage only) ---

type PersistedTab = {
  kind: 'session';
  id: string;
  projectId: number;
  sessionId: string;
  linkedSessionId?: string;
  title: string;
};

type PersistedTabs = {
  tabs: PersistedTab[];
  activeTabId: string | null;
};

function loadTabsFromLocalStorage(): PersistedTabs | null {
  try {
    const raw = localStorage.getItem(TABS_PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedTabs;
    if (!Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs.filter(
      (t): t is PersistedTab => t.kind === 'session' && typeof t.id === 'string' && typeof t.sessionId === 'string',
    );
    const activeTabId = tabs.some(t => t.id === parsed.activeTabId)
      ? parsed.activeTabId
      : (tabs[tabs.length - 1]?.id ?? null);
    return { tabs, activeTabId };
  } catch {
    return null;
  }
}

function writeTabsToLocalStorage(state: AppState) {
  const sessionTabs: PersistedTab[] = state.tabs
    .filter((t): t is Extract<typeof t, { kind: 'session' }> => t.kind === 'session')
    .map(t => ({
      kind: 'session' as const,
      id: t.id,
      projectId: t.projectId,
      sessionId: t.sessionId,
      ...(t.linkedSessionId ? { linkedSessionId: t.linkedSessionId } : {}),
      title: t.title,
    }));
  const activeTabId = sessionTabs.some(t => t.id === state.activeTabId)
    ? state.activeTabId
    : (sessionTabs[sessionTabs.length - 1]?.id ?? null);
  try {
    localStorage.setItem(TABS_PERSIST_KEY, JSON.stringify({ tabs: sessionTabs, activeTabId }));
  } catch { /* storage full */ }
}

// --- Boot: sync hydrate from localStorage ---
applyPersistedToState(loadFromLocalStorage());

// --- Boot: restore persisted tabs ---
const savedTabs = loadTabsFromLocalStorage();
if (savedTabs && savedTabs.tabs.length > 0) {
  useStore.setState({
    tabs: savedTabs.tabs.map(t => ({ ...t, mode: 'history' as const })),
    activeTabId: savedTabs.activeTabId,
  });
}

// --- prevSnapshot tracks last persisted state for diffing ---
let prevSnapshot: Persisted = pickPersistedFields(useStore.getState());

// --- Subscribe: on any state change, diff + write localStorage + SQLite ---
let prevTabsJson = JSON.stringify(useStore.getState().tabs) + '|' + (useStore.getState().activeTabId ?? '');

useStore.subscribe((state) => {
  // Settings persistence
  const next = pickPersistedFields(state);
  const changed = diffKeys(prevSnapshot, next);
  if (changed.length > 0) {
    writeLocalStorage(next);
    for (const key of changed) {
      const value = serializeValue(key, next[key]);
      tauri.setSetting(key, value).catch(err => {
        console.error('[settings] setSetting failed', key, err);
      });
    }
    prevSnapshot = next;
  }

  // Tabs persistence (tabs array or activeTabId change)
  const tabsJson = JSON.stringify(state.tabs) + '|' + (state.activeTabId ?? '');
  if (tabsJson !== prevTabsJson) {
    prevTabsJson = tabsJson;
    writeTabsToLocalStorage(state);
  }
});

const MIGRATION_FLAG_KEY = 'migrated_v2';

function persistedFromRawMap(raw: Record<string, string>): Persisted {
  const out: Persisted = {};
  for (const key of PERSISTED_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    const parsed = deserializeValue(key, v);
    if (parsed === undefined) continue;
    (out as Record<string, unknown>)[key] = parsed;
  }
  return out;
}

async function hydrateFromSqlite(): Promise<void> {
  let raw: Record<string, string>;
  try {
    raw = await tauri.getAllSettings();
  } catch (err) {
    console.error('[settings] hydrateFromSqlite: getAllSettings failed', err);
    return;
  }

  const sqliteHasMigrationFlag = raw[MIGRATION_FLAG_KEY] === '1';
  const sqliteSnapshot = persistedFromRawMap(raw);
  const localSnapshot = loadFromLocalStorage();

  // Case 1: first boot post-migration — SQLite empty, localStorage has data.
  // Use CURRENT state (not the cached localSnapshot) to win any race where the
  // user changed a setting during the async window.
  if (!sqliteHasMigrationFlag && Object.keys(localSnapshot).length > 0) {
    for (const key of PERSISTED_KEYS) {
      const value = pickPersistedFields(useStore.getState())[key];
      if (value === undefined) continue;
      const serialized = serializeValue(key, value);
      try {
        await tauri.setSetting(key, serialized);
      } catch (err) {
        console.error('[settings] migration setSetting failed', key, err);
      }
    }
    try {
      await tauri.setSetting(MIGRATION_FLAG_KEY, '1');
    } catch (err) {
      console.error('[settings] migration flag setSetting failed', err);
    }
    // Reset prevSnapshot to current state — any subscribe-handler writes that landed
    // during the loop have already been persisted by the subscribe path itself.
    prevSnapshot = pickPersistedFields(useStore.getState());
    return;
  }

  // Case 4: fresh install — both empty. Nothing to reconcile.
  if (!sqliteHasMigrationFlag && Object.keys(sqliteSnapshot).length === 0) {
    return;
  }

  // Case 2 / Case 3: SQLite has data, possibly differs from localStorage.
  // SQLite is canonical. To prevent the subscribe handler from re-writing the
  // hydrated values back to SQLite as a "diff", we PRE-SET prevSnapshot to the
  // future state BEFORE applying it.
  const currentState = pickPersistedFields(useStore.getState());
  const futureState: Persisted = { ...currentState, ...sqliteSnapshot };
  prevSnapshot = futureState;
  applyPersistedToState(sqliteSnapshot);
  writeLocalStorage(futureState);
}

async function bootstrapShellPath(): Promise<void> {
  await hydrateFromSqlite();
  if (useStore.getState().shellPath !== '') return;
  try {
    const detected = await tauri.detectDefaultShell();
    if (detected && detected.length > 0) {
      useStore.setState({ shellPath: detected });
    }
  } catch (err) {
    console.error('[settings] detectDefaultShell failed', err);
  }
}

void bootstrapShellPath();
