import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { FileEntry } from '../types';
import type { AppState } from './index';

export const TREE_RENDER_LIMIT = 2000;
export const FILE_SEARCH_DEBOUNCE_MS = 150;

export type DirListing = { status: 'loading' | 'ready' | 'error'; entries: FileEntry[] };
export type FileSearch = {
  query: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  results: string[];
  truncated: boolean;
  selected: number;
};
export type FileTree = { expanded: string[]; listings: Record<string, DirListing> };

export type FilesSlice = {
  filesPanelOpen: boolean;
  fileTrees: Record<number, FileTree>;
  fileSearch: FileSearch;
  openFilesPanel: () => Promise<void>;
  closeFilesPanel: () => void;
  followFilesProject: () => void;
  toggleFileDir: (projectId: number, relDir: string) => Promise<void>;
  reloadFileDir: (projectId: number, relDir: string) => Promise<void>;
  setFileSearchQuery: (projectId: number, query: string) => void;
  moveFileSearchSelection: (delta: 1 | -1) => void;
  retainDirWatch: (projectId: number, relDir: string) => void;
  releaseDirWatch: (projectId: number, relDir: string) => void;
  checkFilesOnDisk: (projectId: number, relDir: string) => Promise<void>;
};

export const childPath = (relDir: string, name: string) => (relDir ? `${relDir}/${name}` : name);

const emptySearch: FileSearch = { query: '', status: 'idle', results: [], truncated: false, selected: 0 };

const watchCounts = new Map<string, number>();
const watchChains = new Map<string, Promise<void>>();
const panelWatches = new Map<number, Set<string>>();
const listTokens = new Map<string, number>();
let searchToken = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let attachedProjectId: number | null = null;

const dirKey = (projectId: number, relDir: string) => `${projectId}\u0000${relDir}`;

function nextListToken(key: string): number {
  const token = (listTokens.get(key) ?? 0) + 1;
  listTokens.set(key, token);
  return token;
}

function enqueueWatch(key: string, task: () => Promise<void>) {
  const next = (watchChains.get(key) ?? Promise.resolve()).then(task).catch(() => undefined);
  watchChains.set(key, next);
}

function cancelSearch() {
  searchToken += 1;
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = null;
}

function activeProjectOf(state: Pick<AppState, 'tabs' | 'activeTabId'>): number | null {
  return state.tabs.find((tab) => tab.id === state.activeTabId)?.projectId ?? null;
}

export const createFilesSlice: StateCreator<AppState, [], [], FilesSlice> = (set, get) => {
  const patchTree = (projectId: number, update: (tree: FileTree) => FileTree) => {
    set((s) => {
      const tree = s.fileTrees[projectId] ?? { expanded: [], listings: {} };
      return { fileTrees: { ...s.fileTrees, [projectId]: update(tree) } };
    });
  };

  const loadDir = async (projectId: number, relDir: string) => {
    const key = dirKey(projectId, relDir);
    const token = nextListToken(key);
    const existing = get().fileTrees[projectId]?.listings[relDir];
    if (existing?.status !== 'ready') {
      patchTree(projectId, (tree) => ({
        ...tree,
        listings: { ...tree.listings, [relDir]: { status: 'loading', entries: existing?.entries ?? [] } },
      }));
    }
    try {
      const entries = await tauri.listProjectDir(projectId, relDir);
      if (listTokens.get(key) !== token) return;
      patchTree(projectId, (tree) => ({
        ...tree,
        listings: { ...tree.listings, [relDir]: { status: 'ready', entries } },
      }));
    } catch {
      if (listTokens.get(key) !== token) return;
      patchTree(projectId, (tree) => ({
        ...tree,
        listings: { ...tree.listings, [relDir]: { status: 'error', entries: tree.listings[relDir]?.entries ?? [] } },
      }));
    }
  };

  const panelRetain = (projectId: number, relDir: string) => {
    const held = panelWatches.get(projectId) ?? new Set<string>();
    if (held.has(relDir)) return;
    held.add(relDir);
    panelWatches.set(projectId, held);
    get().retainDirWatch(projectId, relDir);
  };

  const panelRelease = (projectId: number, relDir: string) => {
    const held = panelWatches.get(projectId);
    if (!held?.delete(relDir)) return;
    if (held.size === 0) panelWatches.delete(projectId);
    get().releaseDirWatch(projectId, relDir);
  };

  const panelReleaseProject = (projectId: number) => {
    for (const relDir of [...(panelWatches.get(projectId) ?? [])]) panelRelease(projectId, relDir);
  };

  const attachProject = (projectId: number) => {
    attachedProjectId = projectId;
    const expanded = get().fileTrees[projectId]?.expanded ?? [];
    for (const relDir of ['', ...expanded]) {
      panelRetain(projectId, relDir);
      void loadDir(projectId, relDir);
    }
  };

  const detachProject = () => {
    if (attachedProjectId !== null) panelReleaseProject(attachedProjectId);
    attachedProjectId = null;
  };

  return {
    filesPanelOpen: false,
    fileTrees: {},
    fileSearch: emptySearch,

    openFilesPanel: async () => {
      if (!(await get().closeNotesPanel())) return;
      const projectId = activeProjectOf(get());
      if (projectId === null) return;
      if (get().filesPanelOpen && attachedProjectId === projectId) return;
      cancelSearch();
      detachProject();
      set({ filesPanelOpen: true, fileSearch: emptySearch });
      attachProject(projectId);
    },

    closeFilesPanel: () => {
      cancelSearch();
      detachProject();
      set({ filesPanelOpen: false, fileSearch: emptySearch });
    },

    followFilesProject: () => {
      const state = get();
      if (!state.filesPanelOpen) return;
      const projectId = activeProjectOf(state);
      if (projectId === null || projectId === attachedProjectId) return;
      cancelSearch();
      detachProject();
      set({ fileSearch: emptySearch });
      attachProject(projectId);
    },

    toggleFileDir: async (projectId, relDir) => {
      const expanded = get().fileTrees[projectId]?.expanded ?? [];
      if (expanded.includes(relDir)) {
        patchTree(projectId, (tree) => ({ ...tree, expanded: tree.expanded.filter((dir) => dir !== relDir) }));
        panelRelease(projectId, relDir);
        return;
      }
      patchTree(projectId, (tree) => ({ ...tree, expanded: [...tree.expanded, relDir] }));
      panelRetain(projectId, relDir);
      await loadDir(projectId, relDir);
    },

    reloadFileDir: (projectId, relDir) => loadDir(projectId, relDir),

    setFileSearchQuery: (projectId, query) => {
      cancelSearch();
      if (query.trim() === '') {
        set({ fileSearch: { ...emptySearch, query } });
        return;
      }
      const token = searchToken;
      set((s) => ({ fileSearch: { ...s.fileSearch, query, status: 'loading', selected: 0 } }));
      searchTimer = setTimeout(() => {
        searchTimer = null;
        void (async () => {
          try {
            const response = await tauri.searchProjectFiles(projectId, query);
            if (searchToken !== token) return;
            set((s) => ({
              fileSearch: { ...s.fileSearch, status: 'ready', results: response.results, truncated: response.truncated, selected: 0 },
            }));
          } catch {
            if (searchToken !== token) return;
            set((s) => ({ fileSearch: { ...s.fileSearch, status: 'error', results: [], truncated: false, selected: 0 } }));
          }
        })();
      }, FILE_SEARCH_DEBOUNCE_MS);
    },

    moveFileSearchSelection: (delta) => {
      set((s) => {
        const last = Math.max(0, s.fileSearch.results.length - 1);
        const selected = Math.min(last, Math.max(0, s.fileSearch.selected + delta));
        return selected === s.fileSearch.selected ? s : { fileSearch: { ...s.fileSearch, selected } };
      });
    },

    retainDirWatch: (projectId, relDir) => {
      const key = dirKey(projectId, relDir);
      const count = watchCounts.get(key) ?? 0;
      watchCounts.set(key, count + 1);
      if (count === 0) enqueueWatch(key, () => tauri.watchProjectDir(projectId, relDir));
    },

    releaseDirWatch: (projectId, relDir) => {
      const key = dirKey(projectId, relDir);
      const count = watchCounts.get(key) ?? 0;
      if (count === 0) return;
      if (count > 1) {
        watchCounts.set(key, count - 1);
        return;
      }
      watchCounts.delete(key);
      enqueueWatch(key, () => tauri.unwatchProjectDir(projectId, relDir));
    },

    checkFilesOnDisk: async () => undefined,
  };
};
