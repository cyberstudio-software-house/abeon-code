import type { StateCreator } from 'zustand';
import { decodeFileText, encodeFileText, fileDir, isMarkdownPath, type Eol } from '../lib/fileText';
import { tauri } from '../lib/tauri';
import type { FileContent, FileEntry } from '../types';
import type { AppState } from './index';
import type { Tab } from './tabsSlice';

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

export type FileBufferView =
  | { kind: 'text' }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'binary'; size: number }
  | { kind: 'tooLarge'; size: number };
export type FileBuffer = {
  tabId: string;
  projectId: number;
  path: string;
  status: 'loading' | 'ready' | 'error';
  error?: string;
  view: FileBufferView;
  content: string;
  savedContent: string;
  eol: Eol;
  hasBom: boolean;
  version: string | null;
  mode: 'edit' | 'preview';
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  saveError?: string;
  disk: 'same' | 'changed' | 'deleted';
};
export type FileSaveResult = 'saved' | 'conflict' | 'error' | 'clean';
export type FileReloadResult = 'reloaded' | 'kept' | 'error';
export type FileSaveFailure = { tabId: string; path: string; result: 'conflict' | 'error' };

export type FilesSlice = {
  filesPanelOpen: boolean;
  fileTrees: Record<number, FileTree>;
  fileSearch: FileSearch;
  fileBuffers: Record<string, FileBuffer>;
  openFilesPanel: () => Promise<void>;
  closeFilesPanel: () => void;
  followFilesProject: () => void;
  toggleFileDir: (projectId: number, relDir: string) => Promise<void>;
  reloadFileDir: (projectId: number, relDir: string) => Promise<void>;
  setFileSearchQuery: (projectId: number, query: string) => void;
  moveFileSearchSelection: (delta: 1 | -1) => void;
  retainDirWatch: (projectId: number, relDir: string) => void;
  releaseDirWatch: (projectId: number, relDir: string) => void;
  loadFileBuffer: (tabId: string) => Promise<void>;
  editFileBuffer: (tabId: string, content: string) => void;
  setFileBufferMode: (tabId: string, mode: 'edit' | 'preview') => void;
  saveFileBuffer: (tabId: string, opts?: { force?: boolean }) => Promise<FileSaveResult>;
  reloadFileBuffer: (tabId: string) => Promise<FileReloadResult>;
  keepFileBuffer: (tabId: string) => void;
  dropFileBuffer: (tabId: string) => void;
  checkFilesOnDisk: (projectId: number, relDir: string) => Promise<void>;
  recheckFiles: () => Promise<void>;
  saveDirtyFiles: (tabIds: string[]) => Promise<FileSaveFailure[]>;
};

type FileTab = Extract<Tab, { kind: 'file' }>;

type BufferRuntime = {
  projectId: number;
  relDir: string;
  readToken: number;
  queue: Promise<void>;
  observedVersion?: string;
};

type ReadIntent =
  | { kind: 'load' }
  | { kind: 'reload'; snapshot: string }
  | { kind: 'silent'; diskVersion: string };

export const childPath = (relDir: string, name: string) => (relDir ? `${relDir}/${name}` : name);

export function isFileDirty(buffer: FileBuffer): boolean {
  if (buffer.status !== 'ready' || buffer.view.kind !== 'text') return false;
  return buffer.content !== buffer.savedContent || (buffer.disk === 'deleted' && buffer.content !== '');
}

export function dirtyFileTabIds(state: Pick<FilesSlice, 'fileBuffers'>): string[] {
  return Object.values(state.fileBuffers).filter(isFileDirty).map((buffer) => buffer.tabId);
}

const fileSavedListeners = new Set<(projectId: number) => void>();

export function onFileSaved(listener: (projectId: number) => void): () => void {
  fileSavedListeners.add(listener);
  return () => { fileSavedListeners.delete(listener); };
}

const emptySearch: FileSearch = { query: '', status: 'idle', results: [], truncated: false, selected: 0 };
const deletedFields = { disk: 'deleted', version: null } as const;

function hasUserEdits(buffer: FileBuffer): boolean {
  return buffer.view.kind === 'text' && buffer.content !== buffer.savedContent;
}

const watchCounts = new Map<string, number>();
const watchChains = new Map<string, Promise<void>>();
const failedWatches = new Set<string>();
const queuedWatchArms = new Set<string>();
const panelWatches = new Map<number, Set<string>>();
const listTokens = new Map<string, number>();
const bufferRuntimes = new Map<string, BufferRuntime>();
let searchToken = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchSequence = Date.now();
let runningSearch: { projectId: number; sequence: number } | null = null;
let attachedProjectId: number | null = null;

const dirKey = (projectId: number, relDir: string) => `${projectId}\u0000${relDir}`;

function failureCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

function failureMessage(error: unknown): string {
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : String(error);
}

function enqueue<T>(runtime: BufferRuntime, task: () => Promise<T>): Promise<T> {
  const next = runtime.queue.then(task);
  runtime.queue = next.then(() => undefined, () => undefined);
  return next;
}

function nextReadToken(runtime: BufferRuntime): number {
  runtime.readToken += 1;
  return runtime.readToken;
}

function emptyBuffer(tab: FileTab): FileBuffer {
  return {
    tabId: tab.id,
    projectId: tab.projectId,
    path: tab.path,
    status: 'loading',
    view: { kind: 'text' },
    content: '',
    savedContent: '',
    eol: 'lf',
    hasBom: false,
    version: null,
    mode: isMarkdownPath(tab.path) ? 'preview' : 'edit',
    saveStatus: 'idle',
    disk: 'same',
  };
}

function loadedFields(file: FileContent): Partial<FileBuffer> {
  const fresh = { status: 'ready' as const, error: undefined, saveStatus: 'idle' as const, saveError: undefined, disk: 'same' as const };
  if (file.kind === 'text') {
    const { text, eol, hasBom } = decodeFileText(file.content);
    return { ...fresh, view: { kind: 'text' }, content: text, savedContent: text, eol, hasBom, version: file.version };
  }
  const blank = { ...fresh, content: '', savedContent: '', eol: 'lf' as const, hasBom: false };
  if (file.kind === 'image') return { ...blank, view: { kind: 'image', dataUrl: file.data_url }, version: file.version };
  return { ...blank, view: { kind: file.kind, size: file.size }, version: file.version };
}

function nextListToken(key: string): number {
  const token = (listTokens.get(key) ?? 0) + 1;
  listTokens.set(key, token);
  return token;
}

function enqueueWatch(key: string, task: () => Promise<void>) {
  const next = (watchChains.get(key) ?? Promise.resolve()).then(task).catch(() => undefined);
  watchChains.set(key, next);
}

function sameEntries(left: FileEntry[], right: FileEntry[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => {
      const other = right[index];
      return entry.name === other.name && entry.kind === other.kind && entry.ignored === other.ignored;
    });
}

async function establishWatch(projectId: number, relDir: string) {
  const key = dirKey(projectId, relDir);
  try {
    await tauri.watchProjectDir(projectId, relDir);
    failedWatches.delete(key);
  } catch {
    failedWatches.add(key);
    console.warn('[files] watch failed', relDir || '.');
  }
}

const isWatchHeld = (key: string) => (watchCounts.get(key) ?? 0) > 0;

function armWatch(projectId: number, relDir: string) {
  const key = dirKey(projectId, relDir);
  if (!isWatchHeld(key) || queuedWatchArms.has(key)) return;
  queuedWatchArms.add(key);
  enqueueWatch(key, async () => {
    queuedWatchArms.delete(key);
    if (!isWatchHeld(key)) return;
    await establishWatch(projectId, relDir);
  });
}

function retryFailedWatch(projectId: number, relDir: string) {
  if (failedWatches.has(dirKey(projectId, relDir))) armWatch(projectId, relDir);
}

function markWatchLost(projectId: number, relDir: string) {
  const key = dirKey(projectId, relDir);
  if (isWatchHeld(key)) failedWatches.add(key);
}

function cancelSearch() {
  searchToken += 1;
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = null;
}

function nextSearchSequence(): number {
  searchSequence += 1;
  return searchSequence;
}

function abandonSearch() {
  cancelSearch();
  const running = runningSearch;
  runningSearch = null;
  if (running) void tauri.searchProjectFiles(running.projectId, '', nextSearchSequence()).catch(() => undefined);
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
      const current = get().fileTrees[projectId]?.listings[relDir];
      if (current?.status !== 'ready' || !sameEntries(current.entries, entries)) {
        patchTree(projectId, (tree) => ({
          ...tree,
          listings: { ...tree.listings, [relDir]: { status: 'ready', entries } },
        }));
      }
      armWatch(projectId, relDir);
    } catch (error) {
      if (failureCode(error) === 'not_found') markWatchLost(projectId, relDir);
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

  const patchBuffer = (tabId: string, patch: Partial<FileBuffer>) => {
    set((s) => (s.fileBuffers[tabId] ? { fileBuffers: { ...s.fileBuffers, [tabId]: { ...s.fileBuffers[tabId], ...patch } } } : s));
  };

  const isAlive = (tabId: string, runtime: BufferRuntime) => bufferRuntimes.get(tabId) === runtime;

  const openRuntime = (tab: FileTab): BufferRuntime => {
    const runtime: BufferRuntime = { projectId: tab.projectId, relDir: fileDir(tab.path), readToken: 0, queue: Promise.resolve() };
    bufferRuntimes.set(tab.id, runtime);
    get().retainDirWatch(runtime.projectId, runtime.relDir);
    return runtime;
  };

  const markChanged = (tabId: string, runtime: BufferRuntime, diskVersion: string | undefined) => {
    if (diskVersion !== undefined) runtime.observedVersion = diskVersion;
    if (get().fileBuffers[tabId]?.disk !== 'changed') patchBuffer(tabId, { disk: 'changed' });
  };

  const markDeleted = (tabId: string, runtime: BufferRuntime) => {
    runtime.observedVersion = undefined;
    patchBuffer(tabId, deletedFields);
  };

  const keepsUserText = (buffer: FileBuffer, intent: ReadIntent, fields: Partial<FileBuffer>) => {
    if (intent.kind === 'load' || !hasUserEdits(buffer)) return false;
    if (fields.view?.kind === 'text' && fields.content === buffer.content) return false;
    return intent.kind === 'silent' || buffer.content !== intent.snapshot;
  };

  const readFromDisk = async (tabId: string, runtime: BufferRuntime, token: number, intent: ReadIntent): Promise<FileReloadResult> => {
    const isLatest = () => isAlive(tabId, runtime) && runtime.readToken === token;
    const buffer = get().fileBuffers[tabId];
    if (!buffer || !isLatest()) return 'kept';
    const diskVersion = intent.kind === 'silent' ? intent.diskVersion : undefined;
    try {
      const file = await tauri.readProjectFile(buffer.projectId, buffer.path);
      const current = get().fileBuffers[tabId];
      if (!current || !isLatest()) return 'kept';
      const fields = loadedFields(file);
      if (keepsUserText(current, intent, fields)) {
        markChanged(tabId, runtime, 'version' in file ? file.version : diskVersion);
        return 'kept';
      }
      runtime.observedVersion = undefined;
      patchBuffer(tabId, fields);
      return 'reloaded';
    } catch (error) {
      const current = get().fileBuffers[tabId];
      if (!current || !isLatest()) return 'kept';
      if (current.status === 'ready' && failureCode(error) === 'not_found') markDeleted(tabId, runtime);
      else if (!isFileDirty(current)) patchBuffer(tabId, { status: 'error', error: failureMessage(error) });
      else if (diskVersion !== undefined && current.disk !== 'deleted') markChanged(tabId, runtime, diskVersion);
      return 'error';
    }
  };

  const compareWithDisk = async (tabId: string, runtime: BufferRuntime) => {
    const buffer = get().fileBuffers[tabId];
    if (buffer?.status !== 'ready' || !isAlive(tabId, runtime)) return;
    let diskVersion: string | null;
    try {
      diskVersion = await tauri.projectFileVersion(buffer.projectId, buffer.path);
      armWatch(runtime.projectId, runtime.relDir);
    } catch (error) {
      if (failureCode(error) !== 'not_found') return;
      markWatchLost(runtime.projectId, runtime.relDir);
      diskVersion = null;
    }
    const current = get().fileBuffers[tabId];
    if (current?.status !== 'ready' || !isAlive(tabId, runtime)) return;
    if (diskVersion === null) {
      if (current.disk !== 'deleted') markDeleted(tabId, runtime);
      return;
    }
    if (diskVersion === current.version) return;
    if (current.disk !== 'deleted' && hasUserEdits(current)) markChanged(tabId, runtime, diskVersion);
    else await readFromDisk(tabId, runtime, runtime.readToken, { kind: 'silent', diskVersion });
  };

  const settleConflict = async (tabId: string, runtime: BufferRuntime, buffer: FileBuffer) => {
    let diskVersion: string | null | undefined;
    try {
      diskVersion = await tauri.projectFileVersion(buffer.projectId, buffer.path);
    } catch {
      diskVersion = undefined;
    }
    if (!isAlive(tabId, runtime)) return;
    if (diskVersion === null) {
      runtime.observedVersion = undefined;
      patchBuffer(tabId, { saveStatus: 'idle', ...deletedFields });
      return;
    }
    if (diskVersion !== undefined) runtime.observedVersion = diskVersion;
    patchBuffer(tabId, { saveStatus: 'idle', disk: 'changed', ...(buffer.version === null ? { savedContent: '' } : {}) });
  };

  const writeToDisk = async (tabId: string, runtime: BufferRuntime, force: boolean): Promise<FileSaveResult> => {
    const buffer = get().fileBuffers[tabId];
    if (!buffer || !isAlive(tabId, runtime)) return 'error';
    if (buffer.status !== 'ready' || buffer.view.kind !== 'text') return 'clean';
    if (!force && buffer.content === buffer.savedContent && buffer.disk !== 'deleted') return 'clean';
    const sent = buffer.content;
    patchBuffer(tabId, { saveStatus: 'saving', saveError: undefined });
    try {
      const version = await tauri.writeProjectFile(
        buffer.projectId, buffer.path, encodeFileText(sent, buffer.eol, buffer.hasBom), buffer.version, force,
      );
      const current = get().fileBuffers[tabId];
      if (current && isAlive(tabId, runtime)) {
        runtime.observedVersion = undefined;
        patchBuffer(tabId, { savedContent: sent, version, disk: 'same', saveStatus: current.content === sent ? 'saved' : 'idle' });
      }
      fileSavedListeners.forEach((listener) => listener(buffer.projectId));
      return 'saved';
    } catch (error) {
      const conflicted = failureCode(error) === 'conflict';
      if (!isAlive(tabId, runtime)) return conflicted ? 'conflict' : 'error';
      if (conflicted) {
        await settleConflict(tabId, runtime, buffer);
        return 'conflict';
      }
      patchBuffer(tabId, { saveStatus: 'error', saveError: failureMessage(error) });
      return 'error';
    }
  };

  return {
    filesPanelOpen: false,
    fileTrees: {},
    fileSearch: emptySearch,
    fileBuffers: {},

    openFilesPanel: async () => {
      if (!(await get().closeNotesPanel())) return;
      const projectId = activeProjectOf(get());
      if (projectId === null) return;
      if (get().filesPanelOpen && attachedProjectId === projectId) return;
      abandonSearch();
      detachProject();
      set({ filesPanelOpen: true, fileSearch: emptySearch });
      attachProject(projectId);
    },

    closeFilesPanel: () => {
      abandonSearch();
      detachProject();
      set({ filesPanelOpen: false, fileSearch: emptySearch });
    },

    followFilesProject: () => {
      const state = get();
      if (!state.filesPanelOpen) return;
      const projectId = activeProjectOf(state);
      if (projectId === null || projectId === attachedProjectId) return;
      abandonSearch();
      detachProject();
      set({ fileSearch: emptySearch });
      attachProject(projectId);
    },

    toggleFileDir: async (projectId, relDir) => {
      const expanded = get().fileTrees[projectId]?.expanded ?? [];
      if (expanded.includes(relDir)) {
        const hidden = (dir: string) => dir === relDir || (relDir === '' ? true : dir.startsWith(`${relDir}/`));
        const collapsed = expanded.filter(hidden);
        patchTree(projectId, (tree) => ({ ...tree, expanded: tree.expanded.filter((dir) => !hidden(dir)) }));
        collapsed.forEach((dir) => panelRelease(projectId, dir));
        return;
      }
      patchTree(projectId, (tree) => ({ ...tree, expanded: [...tree.expanded, relDir] }));
      panelRetain(projectId, relDir);
      await loadDir(projectId, relDir);
    },

    reloadFileDir: (projectId, relDir) => loadDir(projectId, relDir),

    setFileSearchQuery: (projectId, query) => {
      if (query.trim() === '') {
        abandonSearch();
        set({ fileSearch: { ...emptySearch, query } });
        return;
      }
      cancelSearch();
      const token = searchToken;
      set((s) => ({ fileSearch: { ...s.fileSearch, query, status: 'loading', selected: 0 } }));
      searchTimer = setTimeout(() => {
        searchTimer = null;
        const sequence = nextSearchSequence();
        runningSearch = { projectId, sequence };
        void (async () => {
          try {
            const response = await tauri.searchProjectFiles(projectId, query, sequence);
            if (searchToken !== token) return;
            set((s) => ({
              fileSearch: { ...s.fileSearch, status: 'ready', results: response.results, truncated: response.truncated, selected: 0 },
            }));
          } catch {
            if (searchToken !== token) return;
            set((s) => ({ fileSearch: { ...s.fileSearch, status: 'error', results: [], truncated: false, selected: 0 } }));
          } finally {
            if (runningSearch?.sequence === sequence) runningSearch = null;
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
      if (count === 0) enqueueWatch(key, () => establishWatch(projectId, relDir));
      else retryFailedWatch(projectId, relDir);
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
      failedWatches.delete(key);
      enqueueWatch(key, () => tauri.unwatchProjectDir(projectId, relDir));
    },

    loadFileBuffer: async (tabId) => {
      const tab = get().tabs.find((t): t is FileTab => t.id === tabId && t.kind === 'file');
      if (!tab) return;
      const existing = get().fileBuffers[tabId];
      if (existing && existing.status !== 'error') return;
      const runtime = bufferRuntimes.get(tabId) ?? openRuntime(tab);
      const loading = existing ? { ...existing, status: 'loading' as const, error: undefined } : emptyBuffer(tab);
      set((s) => ({ fileBuffers: { ...s.fileBuffers, [tabId]: loading } }));
      const token = nextReadToken(runtime);
      await enqueue(runtime, () => readFromDisk(tabId, runtime, token, { kind: 'load' }));
    },

    editFileBuffer: (tabId, content) => {
      const buffer = get().fileBuffers[tabId];
      if (!buffer || buffer.status !== 'ready' || buffer.view.kind !== 'text' || buffer.content === content) return;
      patchBuffer(tabId, { content, saveStatus: buffer.saveStatus === 'saving' ? 'saving' : 'idle', saveError: undefined });
    },

    setFileBufferMode: (tabId, mode) => {
      const buffer = get().fileBuffers[tabId];
      if (!buffer || buffer.mode === mode || buffer.view.kind !== 'text' || !isMarkdownPath(buffer.path)) return;
      patchBuffer(tabId, { mode });
    },

    saveFileBuffer: (tabId, opts) => {
      const runtime = bufferRuntimes.get(tabId);
      if (!runtime) return Promise.resolve('error');
      return enqueue(runtime, () => writeToDisk(tabId, runtime, opts?.force ?? false));
    },

    reloadFileBuffer: async (tabId) => {
      const runtime = bufferRuntimes.get(tabId);
      const buffer = get().fileBuffers[tabId];
      if (!runtime || !buffer) return 'kept';
      if (buffer.status === 'error') patchBuffer(tabId, { status: 'loading', error: undefined });
      const token = nextReadToken(runtime);
      const intent: ReadIntent = { kind: 'reload', snapshot: buffer.content };
      return enqueue(runtime, () => readFromDisk(tabId, runtime, token, intent));
    },

    keepFileBuffer: (tabId) => {
      const runtime = bufferRuntimes.get(tabId);
      const buffer = get().fileBuffers[tabId];
      if (!runtime || buffer?.disk !== 'changed') return;
      const version = runtime.observedVersion ?? buffer.version;
      runtime.observedVersion = undefined;
      patchBuffer(tabId, { disk: 'same', version });
    },

    dropFileBuffer: (tabId) => {
      const runtime = bufferRuntimes.get(tabId);
      if (runtime) {
        bufferRuntimes.delete(tabId);
        get().releaseDirWatch(runtime.projectId, runtime.relDir);
      }
      if (!get().fileBuffers[tabId]) return;
      set((s) => {
        const { [tabId]: _dropped, ...rest } = s.fileBuffers;
        return { fileBuffers: rest };
      });
    },

    checkFilesOnDisk: async (projectId, relDir) => {
      const checks = Object.values(get().fileBuffers)
        .filter((buffer) => buffer.projectId === projectId && fileDir(buffer.path) === relDir)
        .map((buffer) => {
          const runtime = bufferRuntimes.get(buffer.tabId);
          return runtime ? enqueue(runtime, () => compareWithDisk(buffer.tabId, runtime)) : undefined;
        });
      await Promise.all(checks);
    },

    recheckFiles: async () => {
      const state = get();
      const bufferDirs = new Map<string, { projectId: number; relDir: string }>();
      for (const buffer of Object.values(state.fileBuffers)) {
        const relDir = fileDir(buffer.path);
        bufferDirs.set(dirKey(buffer.projectId, relDir), { projectId: buffer.projectId, relDir });
      }
      const checks = [...bufferDirs.values()].map(({ projectId, relDir }) => state.checkFilesOnDisk(projectId, relDir));
      const projectId = attachedProjectId;
      const listings = state.filesPanelOpen && projectId !== null
        ? [...(panelWatches.get(projectId) ?? [])].map((relDir) => loadDir(projectId, relDir))
        : [];
      await Promise.all([...checks, ...listings]);
    },

    saveDirtyFiles: async (tabIds) => {
      const results = await Promise.all(tabIds.map((tabId) => get().saveFileBuffer(tabId)));
      return tabIds.flatMap((tabId, index): FileSaveFailure[] => {
        const result = results[index];
        if (result === 'saved' || result === 'clean') return [];
        return [{ tabId, path: get().fileBuffers[tabId]?.path ?? tabId, result }];
      });
    },
  };
};
