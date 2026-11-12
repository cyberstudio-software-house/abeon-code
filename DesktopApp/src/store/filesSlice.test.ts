import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../types';

const tauriMock = vi.hoisted(() => ({
  listProjectDir: vi.fn(),
  searchProjectFiles: vi.fn(),
  watchProjectDir: vi.fn(),
  unwatchProjectDir: vi.fn(),
}));

vi.mock('../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, ...tauriMock } };
});

import { useStore } from './index';
import { FILE_SEARCH_DEBOUNCE_MS } from './filesSlice';

const state = () => useStore.getState();

const entry = (name: string, kind: 'dir' | 'file' = 'file', ignored = false): FileEntry => ({ name, kind, ignored });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

const tabsOf = (...projectIds: number[]) => projectIds.map((projectId) => ({
  kind: 'terminal' as const, id: `tab-${projectId}`, projectId, title: 't',
}));

describe('filesSlice', () => {
  const originalCloseNotesPanel = useStore.getState().closeNotesPanel;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.values(tauriMock).forEach((mock) => mock.mockReset());
    tauriMock.watchProjectDir.mockResolvedValue(undefined);
    tauriMock.unwatchProjectDir.mockResolvedValue(undefined);
    tauriMock.listProjectDir.mockResolvedValue([]);
    tauriMock.searchProjectFiles.mockResolvedValue({ results: [], truncated: false });
    useStore.getState().closeFilesPanel();
    useStore.setState({
      tabs: tabsOf(1, 2), activeTabId: 'tab-1', fileTrees: {},
      notesPanelOpen: false, closeNotesPanel: originalCloseNotesPanel,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    useStore.getState().closeFilesPanel();
    vi.useRealTimers();
  });

  it('loads the root and retains its watch when the panel opens', async () => {
    tauriMock.listProjectDir.mockResolvedValue([entry('src', 'dir'), entry('a.txt')]);
    await state().openFilesPanel();
    await flush();
    expect(state().filesPanelOpen).toBe(true);
    expect(tauriMock.listProjectDir).toHaveBeenCalledWith(1, '');
    expect(tauriMock.watchProjectDir).toHaveBeenCalledWith(1, '');
    expect(state().fileTrees[1].listings[''].status).toBe('ready');
    expect(state().fileTrees[1].listings[''].entries).toHaveLength(2);
  });

  it('does not open without an active tab', async () => {
    useStore.setState({ tabs: [], activeTabId: null });
    await state().openFilesPanel();
    expect(state().filesPanelOpen).toBe(false);
    expect(tauriMock.listProjectDir).not.toHaveBeenCalled();
  });

  it('closes the notes panel first and stays closed when it cannot be closed', async () => {
    const closeNotesPanel = vi.fn().mockResolvedValue(false);
    useStore.setState({ closeNotesPanel });
    await state().openFilesPanel();
    expect(closeNotesPanel).toHaveBeenCalledTimes(1);
    expect(state().filesPanelOpen).toBe(false);
    expect(tauriMock.listProjectDir).not.toHaveBeenCalled();

    closeNotesPanel.mockResolvedValue(true);
    await state().openFilesPanel();
    expect(state().filesPanelOpen).toBe(true);
  });

  it('closes the files panel and releases its watches when notes open', async () => {
    await state().openFilesPanel();
    await flush();
    state().openNotesPanel();
    await flush();
    expect(state().filesPanelOpen).toBe(false);
    expect(state().notesPanelOpen).toBe(true);
    expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, '');
  });

  it('expands, loads and retains a directory, then collapses and releases it keeping the listing', async () => {
    await state().openFilesPanel();
    await flush();
    tauriMock.listProjectDir.mockResolvedValue([entry('b.ts')]);
    await state().toggleFileDir(1, 'src');
    expect(state().fileTrees[1].expanded).toEqual(['src']);
    expect(tauriMock.listProjectDir).toHaveBeenCalledWith(1, 'src');
    expect(tauriMock.watchProjectDir).toHaveBeenCalledWith(1, 'src');
    expect(state().fileTrees[1].listings.src.entries).toEqual([entry('b.ts')]);

    await state().toggleFileDir(1, 'src');
    await flush();
    expect(state().fileTrees[1].expanded).toEqual([]);
    expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, 'src');
    expect(state().fileTrees[1].listings.src.entries).toEqual([entry('b.ts')]);
  });

  it('drops a stale listing response', async () => {
    await state().openFilesPanel();
    await flush();
    const first = deferred<FileEntry[]>();
    const second = deferred<FileEntry[]>();
    tauriMock.listProjectDir.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const slow = state().reloadFileDir(1, 'src');
    const fast = state().reloadFileDir(1, 'src');
    second.resolve([entry('new.ts')]);
    await fast;
    first.resolve([entry('old.ts')]);
    await slow;
    expect(state().fileTrees[1].listings.src.entries).toEqual([entry('new.ts')]);
  });

  it('keeps a ready listing while it reloads and marks a failed reload as an error', async () => {
    tauriMock.listProjectDir.mockResolvedValue([entry('a.txt')]);
    await state().openFilesPanel();
    await flush();
    const pending = deferred<FileEntry[]>();
    tauriMock.listProjectDir.mockReturnValueOnce(pending.promise);
    const reload = state().reloadFileDir(1, '');
    expect(state().fileTrees[1].listings[''].status).toBe('ready');
    pending.resolve([]);
    await reload;

    tauriMock.listProjectDir.mockRejectedValueOnce(new Error('gone'));
    await state().reloadFileDir(1, '');
    expect(state().fileTrees[1].listings[''].status).toBe('error');
  });

  it('counts watch retains and releases', async () => {
    state().retainDirWatch(1, 'src');
    state().retainDirWatch(1, 'src');
    await flush();
    expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(1);
    state().releaseDirWatch(1, 'src');
    await flush();
    expect(tauriMock.unwatchProjectDir).not.toHaveBeenCalled();
    state().releaseDirWatch(1, 'src');
    await flush();
    expect(tauriMock.unwatchProjectDir).toHaveBeenCalledTimes(1);
    state().releaseDirWatch(1, 'src');
    await flush();
    expect(tauriMock.unwatchProjectDir).toHaveBeenCalledTimes(1);
  });

  it('keeps a directory watched for another holder when the panel closes', async () => {
    await state().openFilesPanel();
    await flush();
    state().retainDirWatch(1, '');
    state().closeFilesPanel();
    await flush();
    expect(tauriMock.unwatchProjectDir).not.toHaveBeenCalled();
    state().releaseDirWatch(1, '');
    await flush();
    expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, '');
  });

  it('retains expanded directories again when the panel reopens', async () => {
    await state().openFilesPanel();
    await flush();
    await state().toggleFileDir(1, 'src');
    state().closeFilesPanel();
    await flush();
    expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, 'src');
    expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, '');
    tauriMock.watchProjectDir.mockClear();
    tauriMock.listProjectDir.mockClear();
    await state().openFilesPanel();
    await flush();
    expect(state().fileTrees[1].expanded).toEqual(['src']);
    expect(tauriMock.watchProjectDir).toHaveBeenCalledWith(1, '');
    expect(tauriMock.watchProjectDir).toHaveBeenCalledWith(1, 'src');
    expect(tauriMock.listProjectDir).toHaveBeenCalledWith(1, 'src');
  });

  it('follows the project of the active tab', async () => {
    await state().openFilesPanel();
    await flush();
    await state().toggleFileDir(1, 'src');
    state().setFileSearchQuery(1, 'abc');
    useStore.setState({ activeTabId: 'tab-2' });
    await flush();
    expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, '');
    expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, 'src');
    expect(tauriMock.watchProjectDir).toHaveBeenCalledWith(2, '');
    expect(tauriMock.listProjectDir).toHaveBeenCalledWith(2, '');
    expect(state().fileSearch.query).toBe('');
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);
    expect(tauriMock.searchProjectFiles).not.toHaveBeenCalled();
  });

  it('debounces the search and drops a stale response', async () => {
    state().setFileSearchQuery(1, 'a');
    state().setFileSearchQuery(1, 'ab');
    expect(state().fileSearch.status).toBe('loading');
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS - 1);
    expect(tauriMock.searchProjectFiles).not.toHaveBeenCalled();
    const slow = deferred<{ results: string[]; truncated: boolean }>();
    tauriMock.searchProjectFiles.mockReturnValueOnce(slow.promise);
    await vi.advanceTimersByTimeAsync(1);
    expect(tauriMock.searchProjectFiles).toHaveBeenCalledTimes(1);
    expect(tauriMock.searchProjectFiles).toHaveBeenCalledWith(1, 'ab');

    state().setFileSearchQuery(1, 'abc');
    tauriMock.searchProjectFiles.mockResolvedValueOnce({ results: ['abc.ts'], truncated: true });
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);
    slow.resolve({ results: ['stale.ts'], truncated: false });
    await flush();
    expect(state().fileSearch).toMatchObject({ query: 'abc', status: 'ready', results: ['abc.ts'], truncated: true });
  });

  it('marks a failed search as an error', async () => {
    tauriMock.searchProjectFiles.mockRejectedValueOnce(new Error('boom'));
    state().setFileSearchQuery(1, 'abc');
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);
    expect(state().fileSearch.status).toBe('error');
  });

  it('keeps the expanded directories when the query is cleared', async () => {
    await state().openFilesPanel();
    await flush();
    await state().toggleFileDir(1, 'src');
    state().setFileSearchQuery(1, 'abc');
    state().setFileSearchQuery(1, '');
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);
    expect(state().fileSearch).toMatchObject({ query: '', status: 'idle', results: [] });
    expect(tauriMock.searchProjectFiles).not.toHaveBeenCalled();
    expect(state().fileTrees[1].expanded).toEqual(['src']);
  });

  it('clamps the selection to the result range', async () => {
    tauriMock.searchProjectFiles.mockResolvedValue({ results: ['a', 'b', 'c'], truncated: false });
    state().setFileSearchQuery(1, 'x');
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);
    state().moveFileSearchSelection(-1);
    expect(state().fileSearch.selected).toBe(0);
    for (let i = 0; i < 5; i += 1) state().moveFileSearchSelection(1);
    expect(state().fileSearch.selected).toBe(2);
    state().moveFileSearchSelection(-1);
    expect(state().fileSearch.selected).toBe(1);
  });

  it('keeps the selection at zero without results', () => {
    state().moveFileSearchSelection(1);
    expect(state().fileSearch.selected).toBe(0);
  });

  it('closes the panel when the last tab closes', async () => {
    await state().openFilesPanel();
    await flush();
    useStore.setState({ tabs: [], activeTabId: null });
    await flush();
    expect(state().filesPanelOpen).toBe(false);
    expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, '');
  });

  it('exposes a no-op disk check for open files', async () => {
    await expect(state().checkFilesOnDisk(1, '')).resolves.toBeUndefined();
  });
});
