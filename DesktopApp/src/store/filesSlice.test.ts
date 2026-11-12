import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileContent, FileEntry } from '../types';

const tauriMock = vi.hoisted(() => ({
  listProjectDir: vi.fn(),
  searchProjectFiles: vi.fn(),
  watchProjectDir: vi.fn(),
  unwatchProjectDir: vi.fn(),
  readProjectFile: vi.fn(),
  writeProjectFile: vi.fn(),
  projectFileVersion: vi.fn(),
  setDirtyFileCount: vi.fn(),
}));

vi.mock('../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, ...tauriMock } };
});

import { useStore } from './index';
import { FILE_SEARCH_DEBOUNCE_MS, dirtyFileTabIds, isFileDirty, onFileSaved, type FileBuffer } from './filesSlice';
import { fileName, fileTabId } from '../lib/fileText';

const state = () => useStore.getState();

const entry = (name: string, kind: 'dir' | 'file' = 'file', ignored = false): FileEntry => ({ name, kind, ignored });

const textFile = (content: string, version = 'v1'): FileContent => ({ kind: 'text', content, version, size: content.length });

const conflict = { code: 'conflict', message: 'conflict: src/a.ts' };

const addFileTab = (path: string, projectId = 1) => {
  const id = fileTabId(projectId, path);
  useStore.setState((s) => ({ tabs: [...s.tabs, { kind: 'file' as const, id, projectId, path, title: fileName(path) }] }));
  return id;
};

const openBuffer = async (path = 'src/a.ts', file: FileContent = textFile('hello\n')) => {
  const id = addFileTab(path);
  tauriMock.readProjectFile.mockResolvedValueOnce(file);
  await useStore.getState().loadFileBuffer(id);
  return id;
};

const buffer = (id: string) => useStore.getState().fileBuffers[id];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

const tabsOf = (...projectIds: number[]) => projectIds.map((projectId) => ({
  kind: 'terminal' as const, id: `tab-${projectId}`, projectId, title: 't',
}));

const toggleAndSettle = async (projectId: number, relDir: string) => {
  await useStore.getState().toggleFileDir(projectId, relDir);
  await flush();
};

describe('filesSlice', () => {
  const originalCloseNotesPanel = useStore.getState().closeNotesPanel;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.values(tauriMock).forEach((mock) => mock.mockReset());
    tauriMock.watchProjectDir.mockResolvedValue(undefined);
    tauriMock.unwatchProjectDir.mockResolvedValue(undefined);
    tauriMock.listProjectDir.mockResolvedValue([]);
    tauriMock.searchProjectFiles.mockResolvedValue({ results: [], truncated: false });
    tauriMock.readProjectFile.mockResolvedValue(textFile('hello\n'));
    tauriMock.writeProjectFile.mockResolvedValue('v2');
    tauriMock.projectFileVersion.mockResolvedValue('v1');
    tauriMock.setDirtyFileCount.mockResolvedValue(undefined);
    useStore.getState().closeFilesPanel();
    useStore.setState({
      tabs: tabsOf(1, 2), activeTabId: 'tab-1', fileTrees: {},
      notesPanelOpen: false, closeNotesPanel: originalCloseNotesPanel,
    });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    Object.keys(useStore.getState().fileBuffers).forEach((id) => useStore.getState().dropFileBuffer(id));
    useStore.getState().closeFilesPanel();
    await flush();
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

  it('collapsing a directory also releases its expanded descendants and keeps their listings', async () => {
    await state().openFilesPanel();
    await flush();
    tauriMock.listProjectDir.mockResolvedValue([entry('x.ts')]);
    await state().toggleFileDir(1, 'a');
    await state().toggleFileDir(1, 'a/b');
    expect(state().fileTrees[1].expanded).toEqual(['a', 'a/b']);
    await state().toggleFileDir(1, 'a');
    await flush();
    expect(state().fileTrees[1].expanded).toEqual([]);
    expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, 'a');
    expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, 'a/b');
    expect(state().fileTrees[1].listings['a/b'].entries).toEqual([entry('x.ts')]);
  });

  it('does not release a sibling whose name only shares a prefix', async () => {
    await state().openFilesPanel();
    await flush();
    await state().toggleFileDir(1, 'a');
    await state().toggleFileDir(1, 'ab');
    await state().toggleFileDir(1, 'a');
    await flush();
    expect(state().fileTrees[1].expanded).toEqual(['ab']);
    expect(tauriMock.unwatchProjectDir).not.toHaveBeenCalledWith(1, 'ab');
  });

  it('arms the watch of a held directory again after every successful listing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    tauriMock.watchProjectDir.mockRejectedValueOnce(new Error('no watch'));
    const listing = deferred<FileEntry[]>();
    tauriMock.listProjectDir.mockReturnValueOnce(listing.promise);
    await state().openFilesPanel();
    await flush();
    expect(warn).toHaveBeenCalledWith('[files] watch failed', '.');
    expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(1);
    listing.resolve([]);
    await flush();
    expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(2);
    await state().reloadFileDir(1, '');
    await flush();
    expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(3);
    expect(tauriMock.watchProjectDir).toHaveBeenLastCalledWith(1, '');
    warn.mockRestore();
  });

  it('re-arms an expanded directory that was deleted and recreated once it lists again', async () => {
    await state().openFilesPanel();
    await toggleAndSettle(1, 'src');
    tauriMock.watchProjectDir.mockClear();
    tauriMock.listProjectDir.mockRejectedValueOnce({ code: 'not_found', message: 'not found: src' });
    await state().reloadFileDir(1, 'src');
    await flush();
    expect(state().fileTrees[1].listings.src.status).toBe('error');
    expect(tauriMock.watchProjectDir).not.toHaveBeenCalled();
    tauriMock.listProjectDir.mockResolvedValueOnce([entry('index.ts')]);
    await state().reloadFileDir(1, 'src');
    await flush();
    expect(state().fileTrees[1].listings.src).toEqual({ status: 'ready', entries: [entry('index.ts')] });
    expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(1);
    expect(tauriMock.watchProjectDir).toHaveBeenCalledWith(1, 'src');
  });

  it('marks a directory whose listing finds it gone so the next holder arms its watch again', async () => {
    await state().openFilesPanel();
    await toggleAndSettle(1, 'src');
    tauriMock.listProjectDir.mockRejectedValueOnce({ code: 'not_found', message: 'not found: src' });
    await state().reloadFileDir(1, 'src');
    await flush();
    tauriMock.watchProjectDir.mockClear();
    state().retainDirWatch(1, 'src');
    await flush();
    expect(tauriMock.watchProjectDir).toHaveBeenCalledWith(1, 'src');
    state().releaseDirWatch(1, 'src');
    await flush();
  });

  it('queues one watch call per directory while one is still waiting', async () => {
    await state().openFilesPanel();
    await toggleAndSettle(1, 'src');
    const blocked = deferred<undefined>();
    tauriMock.watchProjectDir.mockClear();
    tauriMock.watchProjectDir.mockReturnValueOnce(blocked.promise);
    await state().reloadFileDir(1, 'src');
    await flush();
    await state().reloadFileDir(1, 'src');
    await state().reloadFileDir(1, 'src');
    await flush();
    expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(1);
    blocked.resolve(undefined);
    await flush();
    expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(2);
  });

  it('does not arm the watch of a directory nobody holds after a listing', async () => {
    await state().reloadFileDir(1, 'src');
    await flush();
    expect(tauriMock.watchProjectDir).not.toHaveBeenCalled();
  });

  it('retries a failed watch on the next retain of the directory', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    tauriMock.watchProjectDir.mockRejectedValueOnce(new Error('no watch'));
    state().retainDirWatch(1, 'src');
    await flush();
    state().retainDirWatch(1, 'src');
    await flush();
    expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(2);
    state().releaseDirWatch(1, 'src');
    state().releaseDirWatch(1, 'src');
    await flush();
    warn.mockRestore();
  });

  it('does not retry a failed watch once the directory is released', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    tauriMock.watchProjectDir.mockRejectedValueOnce(new Error('no watch'));
    state().retainDirWatch(1, 'src');
    await flush();
    state().releaseDirWatch(1, 'src');
    await flush();
    await state().reloadFileDir(1, 'src');
    await flush();
    expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('leaves the store untouched when a reload returns the same entries', async () => {
    tauriMock.listProjectDir.mockResolvedValue([entry('src', 'dir'), entry('a.txt')]);
    await state().openFilesPanel();
    await flush();
    const before = state().fileTrees;
    tauriMock.listProjectDir.mockResolvedValue([entry('src', 'dir'), entry('a.txt')]);
    await state().reloadFileDir(1, '');
    expect(state().fileTrees).toBe(before);
    tauriMock.listProjectDir.mockResolvedValue([entry('src', 'dir'), entry('a.txt', 'file', true)]);
    await state().reloadFileDir(1, '');
    expect(state().fileTrees).not.toBe(before);
    expect(state().fileTrees[1].listings[''].entries[1].ignored).toBe(true);
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

  describe('file buffers', () => {
    it('loads a text file, retains the watch of its directory and opens it in edit mode', async () => {
      const id = await openBuffer('src/a.ts', textFile('hello\n'));
      await flush();
      expect(tauriMock.readProjectFile).toHaveBeenCalledWith(1, 'src/a.ts');
      expect(tauriMock.watchProjectDir).toHaveBeenCalledWith(1, 'src');
      expect(buffer(id)).toMatchObject({
        tabId: id, projectId: 1, path: 'src/a.ts', status: 'ready', view: { kind: 'text' },
        content: 'hello\n', savedContent: 'hello\n', eol: 'lf', hasBom: false, version: 'v1',
        mode: 'edit', saveStatus: 'idle', disk: 'same',
      });
      expect(isFileDirty(buffer(id))).toBe(false);
    });

    it('opens a Markdown file in preview mode', async () => {
      const id = await openBuffer('docs/README.md', textFile('# Title\n'));
      expect(buffer(id)).toMatchObject({ status: 'ready', mode: 'preview', content: '# Title\n' });
    });

    it.each([
      ['an image', 'img/logo.png', { kind: 'image', data_url: 'data:image/png;base64,AA==', version: 'v1', size: 1 }, { kind: 'image', dataUrl: 'data:image/png;base64,AA==' }, 'v1'],
      ['a binary file', 'bin/app', { kind: 'binary', version: 'b1', size: 42 }, { kind: 'binary', size: 42 }, 'b1'],
      ['a too large file', 'logs/big.log', { kind: 'tooLarge', version: 'l1', size: 2_000_000 }, { kind: 'tooLarge', size: 2_000_000 }, 'l1'],
    ] as const)('loads %s without text content', async (_label, path, file, view, version) => {
      const id = await openBuffer(path, file);
      expect(buffer(id)).toMatchObject({ status: 'ready', view, content: '', savedContent: '', version, disk: 'same' });
      state().editFileBuffer(id, 'typed');
      expect(buffer(id).content).toBe('');
      expect(isFileDirty(buffer(id))).toBe(false);
      await expect(state().saveFileBuffer(id)).resolves.toBe('clean');
      expect(tauriMock.writeProjectFile).not.toHaveBeenCalled();
    });

    it('shows a read error and retries from it without retaining the watch again', async () => {
      const id = addFileTab('src/a.ts');
      tauriMock.readProjectFile.mockRejectedValueOnce({ code: 'io', message: 'permission denied' });
      await state().loadFileBuffer(id);
      expect(buffer(id)).toMatchObject({ status: 'error', error: 'permission denied' });
      expect(isFileDirty(buffer(id))).toBe(false);
      await state().loadFileBuffer(id);
      expect(buffer(id)).toMatchObject({ status: 'ready', content: 'hello\n' });
      expect(buffer(id).error).toBeUndefined();
      await flush();
      expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(1);
    });

    it('reads once while loading or ready and ignores tabs that are not file tabs', async () => {
      await state().loadFileBuffer('missing');
      await state().loadFileBuffer('tab-1');
      expect(state().fileBuffers).toEqual({});
      expect(tauriMock.readProjectFile).not.toHaveBeenCalled();
      const id = addFileTab('src/a.ts');
      const pending = deferred<FileContent>();
      tauriMock.readProjectFile.mockReturnValueOnce(pending.promise);
      const first = state().loadFileBuffer(id);
      expect(buffer(id).status).toBe('loading');
      await state().loadFileBuffer(id);
      pending.resolve(textFile('a\n'));
      await first;
      await state().loadFileBuffer(id);
      expect(tauriMock.readProjectFile).toHaveBeenCalledTimes(1);
      await flush();
      expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(1);
    });

    it('ignores a load response that arrives after the buffer was dropped', async () => {
      const id = addFileTab('src/a.ts');
      const stale = deferred<FileContent>();
      const fresh = deferred<FileContent>();
      tauriMock.readProjectFile.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
      const first = state().loadFileBuffer(id);
      await flush();
      state().dropFileBuffer(id);
      expect(state().fileBuffers[id]).toBeUndefined();
      const second = state().loadFileBuffer(id);
      await flush();
      stale.resolve(textFile('old\n'));
      await first;
      expect(buffer(id).status).toBe('loading');
      fresh.resolve(textFile('new\n', 'v2'));
      await second;
      expect(buffer(id)).toMatchObject({ status: 'ready', content: 'new\n', version: 'v2' });
    });

    it('ignores a load response that arrives after a newer load started', async () => {
      const id = addFileTab('src/a.ts');
      const slow = deferred<FileContent>();
      const fast = deferred<FileContent>();
      tauriMock.readProjectFile.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
      const first = state().loadFileBuffer(id);
      await flush();
      const second = state().reloadFileBuffer(id);
      slow.resolve(textFile('old\n'));
      await first;
      await flush();
      expect(buffer(id)).toMatchObject({ status: 'loading', content: '' });
      fast.resolve(textFile('new\n', 'v2'));
      await second;
      expect(buffer(id)).toMatchObject({ status: 'ready', content: 'new\n', version: 'v2' });
    });

    it('keeps CRLF and the BOM out of the content and writes them back on save', async () => {
      const raw = '\uFEFFa\r\nb\r\n';
      const id = await openBuffer('src/win.txt', textFile(raw));
      expect(buffer(id)).toMatchObject({ content: 'a\nb\n', savedContent: 'a\nb\n', eol: 'crlf', hasBom: true });
      state().editFileBuffer(id, 'a\nb\nc\n');
      await state().saveFileBuffer(id);
      expect(tauriMock.writeProjectFile).toHaveBeenLastCalledWith(1, 'src/win.txt', '\uFEFFa\r\nb\r\nc\r\n', 'v1', false);

      state().editFileBuffer(id, 'a\nb\n');
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      await state().saveFileBuffer(id);
      expect(tauriMock.writeProjectFile).toHaveBeenLastCalledWith(1, 'src/win.txt', raw, null, false);
    });

    it('becomes dirty on edit and clean with the new version after a save', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'changed\n');
      expect(isFileDirty(buffer(id))).toBe(true);
      expect(dirtyFileTabIds(state())).toEqual([id]);
      const pending = deferred<string>();
      tauriMock.writeProjectFile.mockReturnValueOnce(pending.promise);
      const save = state().saveFileBuffer(id);
      await flush();
      expect(buffer(id).saveStatus).toBe('saving');
      pending.resolve('v2');
      await expect(save).resolves.toBe('saved');
      expect(tauriMock.writeProjectFile).toHaveBeenCalledWith(1, 'src/a.ts', 'changed\n', 'v1', false);
      expect(buffer(id)).toMatchObject({ content: 'changed\n', savedContent: 'changed\n', version: 'v2', disk: 'same', saveStatus: 'saved' });
      expect(dirtyFileTabIds(state())).toEqual([]);
      state().editFileBuffer(id, 'again\n');
      expect(buffer(id).saveStatus).toBe('idle');
    });

    it('tells the save listeners about every save that reached the disk', async () => {
      const listener = vi.fn();
      const stop = onFileSaved(listener);
      const id = await openBuffer();
      await state().saveFileBuffer(id);
      state().editFileBuffer(id, 'mine\n');
      tauriMock.writeProjectFile.mockRejectedValueOnce({ code: 'io', message: 'disk full' });
      await state().saveFileBuffer(id);
      tauriMock.writeProjectFile.mockRejectedValueOnce(conflict);
      await state().saveFileBuffer(id);
      expect(listener).not.toHaveBeenCalled();
      await state().saveFileBuffer(id, { force: true });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(1);
      stop();
      state().editFileBuffer(id, 'again\n');
      await state().saveFileBuffer(id);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not write a clean buffer', async () => {
      const id = await openBuffer();
      await expect(state().saveFileBuffer(id)).resolves.toBe('clean');
      state().editFileBuffer(id, 'x');
      state().editFileBuffer(id, 'hello\n');
      await expect(state().saveFileBuffer(id)).resolves.toBe('clean');
      expect(tauriMock.writeProjectFile).not.toHaveBeenCalled();
    });

    it('fails a save whose buffer is gone, also when it was dropped while the save was queued', async () => {
      await expect(state().saveFileBuffer('missing')).resolves.toBe('error');
      const id = await openBuffer();
      const first = deferred<string>();
      tauriMock.writeProjectFile.mockReturnValueOnce(first.promise);
      state().editFileBuffer(id, 'one\n');
      const save1 = state().saveFileBuffer(id);
      await flush();
      state().editFileBuffer(id, 'two\n');
      const save2 = state().saveFileBuffer(id);
      state().dropFileBuffer(id);
      first.resolve('v2');
      await expect(save1).resolves.toBe('saved');
      await expect(save2).resolves.toBe('error');
      await expect(state().saveDirtyFiles([id])).resolves.toEqual([{ tabId: id, path: id, result: 'error' }]);
      expect(tauriMock.writeProjectFile).toHaveBeenCalledTimes(1);
    });

    it('keeps the edits and flags the disk as changed on a conflict, then overwrites with force', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.writeProjectFile.mockRejectedValueOnce(conflict);
      tauriMock.projectFileVersion.mockResolvedValueOnce('v2');
      await expect(state().saveFileBuffer(id)).resolves.toBe('conflict');
      expect(buffer(id)).toMatchObject({ content: 'mine\n', savedContent: 'hello\n', version: 'v1', disk: 'changed', saveStatus: 'idle' });
      expect(isFileDirty(buffer(id))).toBe(true);
      tauriMock.writeProjectFile.mockResolvedValueOnce('v3');
      await expect(state().saveFileBuffer(id, { force: true })).resolves.toBe('saved');
      expect(tauriMock.writeProjectFile).toHaveBeenLastCalledWith(1, 'src/a.ts', 'mine\n', 'v1', true);
      expect(buffer(id)).toMatchObject({ savedContent: 'mine\n', version: 'v3', disk: 'same', saveStatus: 'saved' });
    });

    it('learns the disk version on a conflict so keeping my edits saves without force', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.writeProjectFile.mockRejectedValueOnce(conflict).mockResolvedValueOnce('v4');
      tauriMock.projectFileVersion.mockResolvedValueOnce('v3');
      await state().saveFileBuffer(id);
      state().keepFileBuffer(id);
      expect(buffer(id)).toMatchObject({ disk: 'same', version: 'v3', content: 'mine\n' });
      await expect(state().saveFileBuffer(id)).resolves.toBe('saved');
      expect(tauriMock.writeProjectFile).toHaveBeenLastCalledWith(1, 'src/a.ts', 'mine\n', 'v3', false);
    });

    it('marks the file as deleted when a save conflicts because the file is gone', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.writeProjectFile.mockRejectedValueOnce(conflict).mockResolvedValueOnce('v5');
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await expect(state().saveFileBuffer(id)).resolves.toBe('conflict');
      expect(buffer(id)).toMatchObject({ content: 'mine\n', savedContent: 'hello\n', disk: 'deleted', version: null, saveStatus: 'idle' });
      await expect(state().saveFileBuffer(id)).resolves.toBe('saved');
      expect(tauriMock.writeProjectFile).toHaveBeenLastCalledWith(1, 'src/a.ts', 'mine\n', null, false);
    });

    it('keeps the content and reports the error when a save fails', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.writeProjectFile.mockRejectedValueOnce({ code: 'io', message: 'disk full' });
      await expect(state().saveFileBuffer(id)).resolves.toBe('error');
      expect(buffer(id)).toMatchObject({
        content: 'mine\n', savedContent: 'hello\n', version: 'v1', disk: 'same', saveStatus: 'error', saveError: 'disk full',
      });
      expect(isFileDirty(buffer(id))).toBe(true);
      state().editFileBuffer(id, 'mine 2\n');
      expect(buffer(id).saveStatus).toBe('idle');
      expect(buffer(id).saveError).toBeUndefined();
    });

    it('serialises two saves and sends the second against the version the first one returned', async () => {
      const id = await openBuffer();
      const first = deferred<string>();
      tauriMock.writeProjectFile.mockReturnValueOnce(first.promise).mockResolvedValueOnce('v3');
      state().editFileBuffer(id, 'one\n');
      const save1 = state().saveFileBuffer(id);
      await flush();
      state().editFileBuffer(id, 'two\n');
      const save2 = state().saveFileBuffer(id);
      await flush();
      expect(tauriMock.writeProjectFile).toHaveBeenCalledTimes(1);
      first.resolve('v2');
      await expect(save1).resolves.toBe('saved');
      await expect(save2).resolves.toBe('saved');
      expect(tauriMock.writeProjectFile).toHaveBeenNthCalledWith(1, 1, 'src/a.ts', 'one\n', 'v1', false);
      expect(tauriMock.writeProjectFile).toHaveBeenNthCalledWith(2, 1, 'src/a.ts', 'two\n', 'v2', false);
      expect(buffer(id)).toMatchObject({ content: 'two\n', savedContent: 'two\n', version: 'v3', saveStatus: 'saved' });
    });

    it('leaves the buffer dirty when it was edited while a save was in flight', async () => {
      const id = await openBuffer();
      const pending = deferred<string>();
      tauriMock.writeProjectFile.mockReturnValueOnce(pending.promise);
      state().editFileBuffer(id, 'one\n');
      const save = state().saveFileBuffer(id);
      await flush();
      state().editFileBuffer(id, 'two\n');
      expect(buffer(id).saveStatus).toBe('saving');
      pending.resolve('v2');
      await expect(save).resolves.toBe('saved');
      expect(buffer(id)).toMatchObject({ content: 'two\n', savedContent: 'one\n', version: 'v2', saveStatus: 'idle' });
      expect(isFileDirty(buffer(id))).toBe(true);
    });

    it('does not bring back or touch a new buffer when a save resolves after its buffer was dropped', async () => {
      const id = await openBuffer();
      const pending = deferred<string>();
      tauriMock.writeProjectFile.mockReturnValueOnce(pending.promise);
      state().editFileBuffer(id, 'mine\n');
      const save = state().saveFileBuffer(id);
      await flush();
      state().dropFileBuffer(id);
      expect(state().fileBuffers[id]).toBeUndefined();
      await state().loadFileBuffer(id);
      pending.resolve('v2');
      await expect(save).resolves.toBe('saved');
      expect(buffer(id)).toMatchObject({ content: 'hello\n', savedContent: 'hello\n', version: 'v1', saveStatus: 'idle' });
    });

    it('does nothing when the file on disk still has the loaded version', async () => {
      const id = await openBuffer();
      const before = buffer(id);
      await state().checkFilesOnDisk(1, 'src');
      expect(tauriMock.projectFileVersion).toHaveBeenCalledWith(1, 'src/a.ts');
      expect(tauriMock.readProjectFile).toHaveBeenCalledTimes(1);
      expect(buffer(id)).toBe(before);
    });

    it('silently reloads a clean buffer whose file changed, keeping it ready and in its mode', async () => {
      const id = await openBuffer('docs/README.md', textFile('# A\n'));
      state().setFileBufferMode(id, 'edit');
      const read = deferred<FileContent>();
      tauriMock.projectFileVersion.mockResolvedValueOnce('v2');
      tauriMock.readProjectFile.mockReturnValueOnce(read.promise);
      const check = state().checkFilesOnDisk(1, 'docs');
      await flush();
      expect(buffer(id)).toMatchObject({ status: 'ready', content: '# A\n' });
      read.resolve(textFile('# B\n', 'v2'));
      await check;
      expect(buffer(id)).toMatchObject({ status: 'ready', content: '# B\n', savedContent: '# B\n', version: 'v2', disk: 'same', mode: 'edit' });
    });

    it('flags a dirty buffer whose file changed and keeps the edits', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.projectFileVersion.mockResolvedValueOnce('v2');
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ content: 'mine\n', savedContent: 'hello\n', version: 'v1', disk: 'changed' });
      expect(tauriMock.readProjectFile).toHaveBeenCalledTimes(1);
    });

    it('marks a deleted file and keeps its content as unsaved until a save recreates it', async () => {
      const id = await openBuffer();
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ content: 'hello\n', savedContent: 'hello\n', version: null, disk: 'deleted' });
      expect(isFileDirty(buffer(id))).toBe(true);
      state().keepFileBuffer(id);
      expect(buffer(id).disk).toBe('deleted');
      tauriMock.writeProjectFile.mockResolvedValueOnce('v5');
      await expect(state().saveFileBuffer(id)).resolves.toBe('saved');
      expect(tauriMock.writeProjectFile).toHaveBeenCalledWith(1, 'src/a.ts', 'hello\n', null, false);
      expect(buffer(id)).toMatchObject({ version: 'v5', disk: 'same' });
      expect(isFileDirty(buffer(id))).toBe(false);
    });

    it.each([
      ['different content', textFile('agent\n', 'v7')],
      ['identical content', textFile('hello\n', 'v7')],
    ])('silently reloads an unedited deleted buffer when its file comes back with %s', async (_label, file) => {
      const id = await openBuffer();
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id).disk).toBe('deleted');
      expect(dirtyFileTabIds(state())).toEqual([id]);
      tauriMock.projectFileVersion.mockResolvedValueOnce('v7');
      tauriMock.readProjectFile.mockResolvedValueOnce(file);
      await state().checkFilesOnDisk(1, 'src');
      const text = file.kind === 'text' ? file.content : '';
      expect(buffer(id)).toMatchObject({ content: text, savedContent: text, version: 'v7', disk: 'same' });
      expect(dirtyFileTabIds(state())).toEqual([]);
    });

    it('keeps edited text when the deleted file comes back with other content, so keeping it saves it', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      tauriMock.projectFileVersion.mockResolvedValueOnce('v7');
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('agent\n', 'v7'));
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ content: 'mine\n', savedContent: 'hello\n', disk: 'changed', version: null });
      expect(isFileDirty(buffer(id))).toBe(true);
      state().keepFileBuffer(id);
      expect(buffer(id)).toMatchObject({ disk: 'same', version: 'v7' });
      expect(isFileDirty(buffer(id))).toBe(true);
      tauriMock.writeProjectFile.mockResolvedValueOnce('v8');
      await expect(state().saveFileBuffer(id)).resolves.toBe('saved');
      expect(tauriMock.writeProjectFile).toHaveBeenCalledWith(1, 'src/a.ts', 'mine\n', 'v7', false);
      expect(isFileDirty(buffer(id))).toBe(false);
    });

    it('keeps text edited while the file was deleted when the file comes back', async () => {
      const id = await openBuffer();
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      state().editFileBuffer(id, 'mine\n');
      tauriMock.projectFileVersion.mockResolvedValueOnce('v7');
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('hello\n', 'v7'));
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ content: 'mine\n', disk: 'changed' });
      expect(isFileDirty(buffer(id))).toBe(true);
    });

    it('adopts a file that comes back with exactly the edited text, taking its line endings and BOM', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      tauriMock.projectFileVersion.mockResolvedValueOnce('v7');
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('\uFEFFmine\r\n', 'v7'));
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({
        content: 'mine\n', savedContent: 'mine\n', version: 'v7', disk: 'same', eol: 'crlf', hasBom: true,
      });
      expect(isFileDirty(buffer(id))).toBe(false);
    });

    it('marks a changed buffer deleted again when its file goes missing again', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      tauriMock.projectFileVersion.mockResolvedValueOnce('v7');
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('agent\n', 'v7'));
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ disk: 'changed', version: null });
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ content: 'mine\n', disk: 'deleted', version: null });
      expect(isFileDirty(buffer(id))).toBe(true);
    });

    it('keeps a deleted buffer marked deleted when the file that came back cannot be read', async () => {
      const id = await openBuffer();
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      tauriMock.projectFileVersion.mockResolvedValueOnce('v7');
      tauriMock.readProjectFile.mockRejectedValueOnce({ code: 'io', message: 'permission denied' });
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ status: 'ready', content: 'hello\n', disk: 'deleted', version: null });
      expect(isFileDirty(buffer(id))).toBe(true);
    });

    it('stays dirty when saving an unedited deleted file conflicts because it came back, so force writes it', async () => {
      const id = await openBuffer();
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      tauriMock.writeProjectFile.mockRejectedValueOnce(conflict).mockResolvedValueOnce('v8');
      tauriMock.projectFileVersion.mockResolvedValueOnce('v7');
      await expect(state().saveFileBuffer(id)).resolves.toBe('conflict');
      expect(buffer(id)).toMatchObject({ content: 'hello\n', disk: 'changed' });
      expect(isFileDirty(buffer(id))).toBe(true);
      tauriMock.projectFileVersion.mockResolvedValueOnce('v7');
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id).disk).toBe('changed');
      expect(isFileDirty(buffer(id))).toBe(true);
      await expect(state().saveFileBuffer(id, { force: true })).resolves.toBe('saved');
      expect(tauriMock.writeProjectFile).toHaveBeenLastCalledWith(1, 'src/a.ts', 'hello\n', null, true);
      expect(buffer(id)).toMatchObject({ savedContent: 'hello\n', version: 'v8', disk: 'same' });
    });

    it('treats a deleted empty buffer as clean and reloads it when the file comes back', async () => {
      const id = await openBuffer('src/empty.txt', textFile(''));
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ disk: 'deleted', content: '' });
      expect(isFileDirty(buffer(id))).toBe(false);
      tauriMock.projectFileVersion.mockResolvedValueOnce('v3');
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('agent\n', 'v3'));
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ content: 'agent\n', savedContent: 'agent\n', version: 'v3', disk: 'same' });
    });

    it('recreates a deleted empty file on save although it has nothing to lose', async () => {
      const id = await openBuffer('src/empty.txt', textFile(''));
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      expect(isFileDirty(buffer(id))).toBe(false);
      await expect(state().saveFileBuffer(id)).resolves.toBe('saved');
      expect(tauriMock.writeProjectFile).toHaveBeenCalledWith(1, 'src/empty.txt', '', null, false);
    });

    it('writes an emptied buffer on a forced save although it equals the saved content', async () => {
      const id = await openBuffer('src/a.ts', textFile(''));
      useStore.setState((s) => ({ fileBuffers: { ...s.fileBuffers, [id]: { ...s.fileBuffers[id], disk: 'changed' } } }));
      expect(buffer(id)).toMatchObject({ content: '', savedContent: '', disk: 'changed' });
      await expect(state().saveFileBuffer(id)).resolves.toBe('clean');
      expect(tauriMock.writeProjectFile).not.toHaveBeenCalled();
      tauriMock.writeProjectFile.mockResolvedValueOnce('v9');
      await expect(state().saveFileBuffer(id, { force: true })).resolves.toBe('saved');
      expect(tauriMock.writeProjectFile).toHaveBeenCalledWith(1, 'src/a.ts', '', 'v1', true);
    });

    it('does nothing after its own save', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.writeProjectFile.mockResolvedValueOnce('v2');
      await state().saveFileBuffer(id);
      tauriMock.projectFileVersion.mockResolvedValueOnce('v2');
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ content: 'mine\n', version: 'v2', disk: 'same' });
      expect(tauriMock.readProjectFile).toHaveBeenCalledTimes(1);
    });

    it('waits for an in-flight save before comparing versions', async () => {
      const id = await openBuffer();
      const pending = deferred<string>();
      tauriMock.writeProjectFile.mockReturnValueOnce(pending.promise);
      tauriMock.projectFileVersion.mockResolvedValue('v2');
      state().editFileBuffer(id, 'mine\n');
      const save = state().saveFileBuffer(id);
      const check = state().checkFilesOnDisk(1, 'src');
      await flush();
      expect(tauriMock.projectFileVersion).not.toHaveBeenCalled();
      pending.resolve('v2');
      await save;
      await check;
      expect(tauriMock.projectFileVersion).toHaveBeenCalledTimes(1);
      expect(buffer(id)).toMatchObject({ content: 'mine\n', savedContent: 'mine\n', version: 'v2', disk: 'same' });
      expect(tauriMock.readProjectFile).toHaveBeenCalledTimes(1);
    });

    it('waits for the initial load before comparing versions', async () => {
      const id = addFileTab('src/a.ts');
      const read = deferred<FileContent>();
      tauriMock.readProjectFile.mockReturnValueOnce(read.promise);
      tauriMock.projectFileVersion.mockResolvedValueOnce('v2');
      const load = state().loadFileBuffer(id);
      const check = state().checkFilesOnDisk(1, 'src');
      await flush();
      expect(tauriMock.projectFileVersion).not.toHaveBeenCalled();
      read.resolve(textFile('old\n'));
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('new\n', 'v2'));
      await load;
      await check;
      expect(buffer(id)).toMatchObject({ content: 'new\n', version: 'v2', disk: 'same' });
    });

    it('does not reload a buffer that became dirty while the version check was in flight', async () => {
      const id = await openBuffer();
      const version = deferred<string | null>();
      tauriMock.projectFileVersion.mockReturnValueOnce(version.promise);
      const check = state().checkFilesOnDisk(1, 'src');
      await flush();
      expect(tauriMock.projectFileVersion).toHaveBeenCalledTimes(1);
      state().editFileBuffer(id, 'mine\n');
      version.resolve('v2');
      await check;
      expect(buffer(id)).toMatchObject({ content: 'mine\n', version: 'v1', disk: 'changed' });
      expect(tauriMock.readProjectFile).toHaveBeenCalledTimes(1);
    });

    it('drops a silent reload when the buffer became dirty during the read', async () => {
      const id = await openBuffer();
      const read = deferred<FileContent>();
      tauriMock.projectFileVersion.mockResolvedValueOnce('v2');
      tauriMock.readProjectFile.mockReturnValueOnce(read.promise);
      const check = state().checkFilesOnDisk(1, 'src');
      await flush();
      expect(tauriMock.readProjectFile).toHaveBeenCalledTimes(2);
      state().editFileBuffer(id, 'mine\n');
      read.resolve(textFile('agent\n', 'v3'));
      await check;
      expect(buffer(id)).toMatchObject({ content: 'mine\n', savedContent: 'hello\n', version: 'v1', disk: 'changed' });
      state().keepFileBuffer(id);
      expect(buffer(id)).toMatchObject({ disk: 'same', version: 'v3' });
    });

    it('turns a clean buffer into an error when a silent reload cannot read the file', async () => {
      const id = await openBuffer();
      tauriMock.projectFileVersion.mockResolvedValueOnce('v2');
      tauriMock.readProjectFile.mockRejectedValueOnce({ code: 'io', message: 'permission denied' });
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ status: 'error', error: 'permission denied' });
    });

    it('marks the buffer deleted when a silent reload finds the file gone', async () => {
      const id = await openBuffer();
      tauriMock.projectFileVersion.mockResolvedValueOnce('v2');
      tauriMock.readProjectFile.mockRejectedValueOnce({ code: 'not_found', message: 'not found: src/a.ts' });
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ status: 'ready', content: 'hello\n', savedContent: 'hello\n', disk: 'deleted', version: null });
    });

    it('marks the buffer deleted when the version check finds its directory gone', async () => {
      const clean = await openBuffer('src/a.ts');
      const edited = await openBuffer('src/b.ts');
      state().editFileBuffer(edited, 'mine\n');
      tauriMock.projectFileVersion.mockRejectedValue({ code: 'not_found', message: 'not found: src/a.ts' });
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(clean)).toMatchObject({ status: 'ready', content: 'hello\n', disk: 'deleted', version: null });
      expect(buffer(edited)).toMatchObject({ status: 'ready', content: 'mine\n', disk: 'deleted', version: null });
      expect(isFileDirty(buffer(clean))).toBe(true);
      expect(isFileDirty(buffer(edited))).toBe(true);
    });

    it('reloads an unedited buffer silently when its deleted directory comes back', async () => {
      const id = await openBuffer('src/a.ts');
      tauriMock.projectFileVersion.mockRejectedValueOnce({ code: 'not_found', message: 'not found: src/a.ts' });
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id).disk).toBe('deleted');
      tauriMock.projectFileVersion.mockResolvedValueOnce('v7');
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('agent\n', 'v7'));
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toMatchObject({ content: 'agent\n', savedContent: 'agent\n', version: 'v7', disk: 'same' });
    });

    it('leaves the buffer alone when the version check fails for another reason', async () => {
      const id = await openBuffer('src/a.ts');
      const before = buffer(id);
      tauriMock.projectFileVersion.mockRejectedValueOnce({ code: 'io', message: 'permission denied' });
      await state().checkFilesOnDisk(1, 'src');
      expect(buffer(id)).toBe(before);
    });

    it('arms the watch of the buffer directory again after a successful version check', async () => {
      const id = await openBuffer('src/a.ts');
      await flush();
      expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(1);
      await state().checkFilesOnDisk(1, 'src');
      await flush();
      expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(2);
      expect(tauriMock.watchProjectDir).toHaveBeenLastCalledWith(1, 'src');
      tauriMock.projectFileVersion.mockResolvedValueOnce(null);
      await state().checkFilesOnDisk(1, 'src');
      await flush();
      expect(buffer(id).disk).toBe('deleted');
      expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(3);
    });

    it('marks the directory for a new watch when the version check finds it gone', async () => {
      await openBuffer('src/a.ts');
      await flush();
      tauriMock.projectFileVersion.mockRejectedValueOnce({ code: 'not_found', message: 'not found: src/a.ts' });
      await state().checkFilesOnDisk(1, 'src');
      await flush();
      expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(1);
      await openBuffer('src/b.ts');
      await flush();
      expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(2);
      expect(tauriMock.watchProjectDir).toHaveBeenLastCalledWith(1, 'src');
    });

    it('checks every open buffer directory and re-lists the panel directories on a re-check', async () => {
      await state().openFilesPanel();
      await toggleAndSettle(1, 'src');
      await openBuffer('src/a.ts');
      await openBuffer('lib/b.ts');
      const other = addFileTab('docs/c.md', 2);
      await state().loadFileBuffer(other);
      tauriMock.listProjectDir.mockClear();
      await state().recheckFiles();
      expect(tauriMock.projectFileVersion).toHaveBeenCalledTimes(3);
      expect(tauriMock.projectFileVersion).toHaveBeenCalledWith(1, 'src/a.ts');
      expect(tauriMock.projectFileVersion).toHaveBeenCalledWith(1, 'lib/b.ts');
      expect(tauriMock.projectFileVersion).toHaveBeenCalledWith(2, 'docs/c.md');
      expect(tauriMock.listProjectDir).toHaveBeenCalledTimes(2);
      expect(tauriMock.listProjectDir).toHaveBeenCalledWith(1, '');
      expect(tauriMock.listProjectDir).toHaveBeenCalledWith(1, 'src');
    });

    it('re-checks only the buffers while the panel is closed', async () => {
      await openBuffer('src/a.ts');
      await state().recheckFiles();
      expect(tauriMock.projectFileVersion).toHaveBeenCalledWith(1, 'src/a.ts');
      expect(tauriMock.listProjectDir).not.toHaveBeenCalled();
    });

    it('lets a re-check bring back a tab and an expanded directory that were deleted and recreated', async () => {
      await state().openFilesPanel();
      await toggleAndSettle(1, 'src');
      const id = await openBuffer('src/a.ts');
      tauriMock.listProjectDir.mockRejectedValueOnce({ code: 'not_found', message: 'not found: src' });
      tauriMock.projectFileVersion.mockRejectedValueOnce({ code: 'not_found', message: 'not found: src/a.ts' });
      await state().reloadFileDir(1, 'src');
      await state().checkFilesOnDisk(1, 'src');
      await flush();
      expect(state().fileTrees[1].listings.src.status).toBe('error');
      expect(buffer(id).disk).toBe('deleted');
      tauriMock.watchProjectDir.mockClear();
      tauriMock.listProjectDir.mockResolvedValue([entry('a.ts')]);
      tauriMock.projectFileVersion.mockResolvedValueOnce('v7');
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('agent\n', 'v7'));
      await state().recheckFiles();
      await flush();
      expect(state().fileTrees[1].listings.src).toEqual({ status: 'ready', entries: [entry('a.ts')] });
      expect(buffer(id)).toMatchObject({ content: 'agent\n', version: 'v7', disk: 'same' });
      expect(tauriMock.watchProjectDir).toHaveBeenCalledWith(1, 'src');
    });

    it('checks only ready buffers of the changed directory', async () => {
      await openBuffer('src/a.ts');
      await openBuffer('src/deep/b.ts');
      await openBuffer('lib/a.ts');
      const otherProject = addFileTab('src/a.ts', 2);
      await state().loadFileBuffer(otherProject);
      const failed = addFileTab('src/broken.ts');
      tauriMock.readProjectFile.mockRejectedValueOnce({ code: 'io', message: 'denied' });
      await state().loadFileBuffer(failed);
      await state().checkFilesOnDisk(1, 'src');
      expect(tauriMock.projectFileVersion).toHaveBeenCalledTimes(1);
      expect(tauriMock.projectFileVersion).toHaveBeenCalledWith(1, 'src/a.ts');
    });

    it('reloads a binary file once per new version on disk and notices its deletion', async () => {
      const id = await openBuffer('bin/app', { kind: 'binary', version: 'x0', size: 1 });
      tauriMock.projectFileVersion.mockResolvedValue('x1');
      tauriMock.readProjectFile.mockResolvedValue({ kind: 'binary', version: 'x1', size: 2 });
      await state().checkFilesOnDisk(1, 'bin');
      expect(buffer(id)).toMatchObject({ view: { kind: 'binary', size: 2 }, version: 'x1' });
      await state().checkFilesOnDisk(1, 'bin');
      expect(tauriMock.readProjectFile).toHaveBeenCalledTimes(2);
      tauriMock.projectFileVersion.mockResolvedValue(null);
      await state().checkFilesOnDisk(1, 'bin');
      expect(buffer(id)).toMatchObject({ disk: 'deleted', version: null });
      expect(isFileDirty(buffer(id))).toBe(false);
    });

    it('keeps my edits against the changed file so the next save succeeds without force', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.projectFileVersion.mockResolvedValueOnce('v2');
      await state().checkFilesOnDisk(1, 'src');
      state().keepFileBuffer(id);
      expect(buffer(id)).toMatchObject({ disk: 'same', version: 'v2', content: 'mine\n' });
      expect(isFileDirty(buffer(id))).toBe(true);
      tauriMock.writeProjectFile.mockResolvedValueOnce('v3');
      await expect(state().saveFileBuffer(id)).resolves.toBe('saved');
      expect(tauriMock.writeProjectFile).toHaveBeenCalledWith(1, 'src/a.ts', 'mine\n', 'v2', false);
    });

    it('reloads from disk and drops the edits', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.projectFileVersion.mockResolvedValueOnce('v2');
      await state().checkFilesOnDisk(1, 'src');
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('agent\n', 'v2'));
      await expect(state().reloadFileBuffer(id)).resolves.toBe('reloaded');
      expect(buffer(id)).toMatchObject({ content: 'agent\n', savedContent: 'agent\n', version: 'v2', disk: 'same', saveStatus: 'idle' });
      expect(isFileDirty(buffer(id))).toBe(false);
      await expect(state().reloadFileBuffer('missing')).resolves.toBe('kept');
    });

    it('keeps text typed during an explicit reload and flags the file as changed', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      const read = deferred<FileContent>();
      tauriMock.readProjectFile.mockReturnValueOnce(read.promise);
      const reload = state().reloadFileBuffer(id);
      await flush();
      state().editFileBuffer(id, 'mine 2\n');
      read.resolve(textFile('agent\n', 'v2'));
      await expect(reload).resolves.toBe('kept');
      expect(buffer(id)).toMatchObject({ content: 'mine 2\n', savedContent: 'hello\n', version: 'v1', disk: 'changed' });
      state().keepFileBuffer(id);
      expect(buffer(id)).toMatchObject({ disk: 'same', version: 'v2' });
    });

    it('keeps text typed while an explicit reload waits behind a save', async () => {
      const id = await openBuffer();
      const pending = deferred<string>();
      tauriMock.writeProjectFile.mockReturnValueOnce(pending.promise);
      state().editFileBuffer(id, 'saved\n');
      const save = state().saveFileBuffer(id);
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('saved\n', 'v2'));
      const reload = state().reloadFileBuffer(id);
      await flush();
      state().editFileBuffer(id, 'typed\n');
      pending.resolve('v2');
      await save;
      await expect(reload).resolves.toBe('kept');
      expect(buffer(id)).toMatchObject({ content: 'typed\n', savedContent: 'saved\n', disk: 'changed' });
    });

    it('saves with the line endings found by the last reload', async () => {
      const id = await openBuffer('src/a.ts', textFile('a\nb\n'));
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('a\r\nb\r\n', 'v2'));
      await expect(state().reloadFileBuffer(id)).resolves.toBe('reloaded');
      expect(buffer(id)).toMatchObject({ content: 'a\nb\n', eol: 'crlf', version: 'v2' });
      state().editFileBuffer(id, 'a\nb\nc\n');
      await state().saveFileBuffer(id);
      expect(tauriMock.writeProjectFile).toHaveBeenLastCalledWith(1, 'src/a.ts', 'a\r\nb\r\nc\r\n', 'v2', false);
    });

    it('reloads only after an in-flight save has finished', async () => {
      const id = await openBuffer();
      const pending = deferred<string>();
      tauriMock.writeProjectFile.mockReturnValueOnce(pending.promise);
      state().editFileBuffer(id, 'mine\n');
      const save = state().saveFileBuffer(id);
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('mine\n', 'v2'));
      const reload = state().reloadFileBuffer(id);
      await flush();
      expect(tauriMock.readProjectFile).toHaveBeenCalledTimes(1);
      pending.resolve('v2');
      await save;
      await reload;
      expect(tauriMock.readProjectFile).toHaveBeenCalledTimes(2);
      expect(buffer(id)).toMatchObject({ content: 'mine\n', savedContent: 'mine\n', version: 'v2', disk: 'same' });
    });

    it('keeps the edits as a deleted file when a reload finds the file gone', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.readProjectFile.mockRejectedValueOnce({ code: 'not_found', message: 'not found: src/a.ts' });
      await expect(state().reloadFileBuffer(id)).resolves.toBe('error');
      expect(buffer(id)).toMatchObject({ status: 'ready', content: 'mine\n', savedContent: 'hello\n', disk: 'deleted', version: null });
      expect(isFileDirty(buffer(id))).toBe(true);
    });

    it('reports a failed reload, keeping a dirty buffer untouched and showing the error for a clean one', async () => {
      const id = await openBuffer();
      state().editFileBuffer(id, 'mine\n');
      tauriMock.readProjectFile.mockRejectedValueOnce({ code: 'io', message: 'permission denied' });
      const before = buffer(id);
      await expect(state().reloadFileBuffer(id)).resolves.toBe('error');
      expect(buffer(id)).toBe(before);
      expect(isFileDirty(buffer(id))).toBe(true);

      const clean = await openBuffer('src/b.ts');
      tauriMock.readProjectFile.mockRejectedValueOnce({ code: 'io', message: 'permission denied' });
      await expect(state().reloadFileBuffer(clean)).resolves.toBe('error');
      expect(buffer(clean)).toMatchObject({ status: 'error', error: 'permission denied' });
    });

    it('switches the mode of a Markdown file without touching its content', async () => {
      const id = await openBuffer('docs/README.md', textFile('# A\n'));
      state().editFileBuffer(id, '# B\n');
      state().setFileBufferMode(id, 'edit');
      expect(buffer(id)).toMatchObject({ mode: 'edit', content: '# B\n', savedContent: '# A\n' });
      state().setFileBufferMode(id, 'preview');
      expect(buffer(id)).toMatchObject({ mode: 'preview', content: '# B\n' });
      const code = await openBuffer('src/a.ts');
      state().setFileBufferMode(code, 'preview');
      expect(buffer(code).mode).toBe('edit');
    });

    it('releases the directory watch exactly once when a buffer is dropped, also after a failed load', async () => {
      const id = await openBuffer('src/a.ts');
      const failed = addFileTab('lib/b.ts');
      tauriMock.readProjectFile.mockRejectedValueOnce({ code: 'not_found', message: 'gone' });
      await state().loadFileBuffer(failed);
      await flush();
      expect(buffer(failed).status).toBe('error');
      state().dropFileBuffer(id);
      state().dropFileBuffer(failed);
      state().dropFileBuffer(failed);
      await flush();
      expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, 'src');
      expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, 'lib');
      expect(tauriMock.unwatchProjectDir).toHaveBeenCalledTimes(2);
      expect(state().fileBuffers).toEqual({});
    });

    it('shares the directory watch between buffers of the same directory', async () => {
      const a = await openBuffer('src/a.ts');
      const b = await openBuffer('src/b.ts');
      await flush();
      expect(tauriMock.watchProjectDir).toHaveBeenCalledTimes(1);
      state().dropFileBuffer(a);
      await flush();
      expect(tauriMock.unwatchProjectDir).not.toHaveBeenCalled();
      state().dropFileBuffer(b);
      await flush();
      expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, 'src');
    });

    it('drops the buffer when its tab closes', async () => {
      const id = await openBuffer();
      const other = await openBuffer('src/b.ts');
      useStore.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== id && t.id !== other) }));
      await flush();
      expect(state().fileBuffers).toEqual({});
      expect(tauriMock.unwatchProjectDir).toHaveBeenCalledWith(1, 'src');
    });

    it('reports the dirty file count only when it changes', async () => {
      const a = await openBuffer('src/a.ts');
      const b = await openBuffer('src/b.ts');
      await flush();
      expect(tauriMock.setDirtyFileCount).not.toHaveBeenCalled();
      state().editFileBuffer(a, 'x');
      await flush();
      expect(tauriMock.setDirtyFileCount).toHaveBeenLastCalledWith(1);
      state().editFileBuffer(a, 'xy');
      await flush();
      state().editFileBuffer(b, 'z');
      await flush();
      expect(tauriMock.setDirtyFileCount).toHaveBeenLastCalledWith(2);
      expect(tauriMock.setDirtyFileCount).toHaveBeenCalledTimes(2);
      useStore.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== b) }));
      await flush();
      expect(tauriMock.setDirtyFileCount).toHaveBeenLastCalledWith(1);
      await state().saveFileBuffer(a);
      await flush();
      expect(tauriMock.setDirtyFileCount).toHaveBeenLastCalledWith(0);
      expect(tauriMock.setDirtyFileCount).toHaveBeenCalledTimes(4);
    });

    it('reports the count after the drop when one update closes a tab and edits another buffer', async () => {
      const a = await openBuffer('src/a.ts');
      const b = await openBuffer('src/b.ts');
      state().editFileBuffer(a, 'x');
      state().editFileBuffer(b, 'y');
      await flush();
      expect(tauriMock.setDirtyFileCount).toHaveBeenLastCalledWith(2);
      useStore.setState((s) => ({
        tabs: s.tabs.filter((t) => t.id !== b),
        fileBuffers: { ...s.fileBuffers, [a]: { ...s.fileBuffers[a], content: 'xy' } },
      }));
      await flush();
      expect(state().fileBuffers[b]).toBeUndefined();
      expect(tauriMock.setDirtyFileCount).toHaveBeenLastCalledWith(1);
    });

    it('sends one dirty count report at a time and then the latest count', async () => {
      const a = await openBuffer('src/a.ts');
      const b = await openBuffer('src/b.ts');
      const first = deferred<undefined>();
      tauriMock.setDirtyFileCount.mockReturnValueOnce(first.promise);
      state().editFileBuffer(a, 'x');
      state().editFileBuffer(b, 'y');
      await flush();
      expect(tauriMock.setDirtyFileCount).toHaveBeenCalledTimes(1);
      expect(tauriMock.setDirtyFileCount).toHaveBeenLastCalledWith(1);
      first.resolve(undefined);
      await flush();
      expect(tauriMock.setDirtyFileCount).toHaveBeenCalledTimes(2);
      expect(tauriMock.setDirtyFileCount).toHaveBeenLastCalledWith(2);
    });

    it('retries a failed dirty count report on the next change', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const a = await openBuffer('src/a.ts');
      tauriMock.setDirtyFileCount.mockRejectedValueOnce(new Error('ipc down'));
      state().editFileBuffer(a, 'x');
      await flush();
      expect(error).toHaveBeenCalledWith('[files] setDirtyFileCount failed', expect.any(Error));
      expect(tauriMock.setDirtyFileCount).toHaveBeenCalledTimes(1);
      state().editFileBuffer(a, 'xy');
      await flush();
      expect(tauriMock.setDirtyFileCount).toHaveBeenCalledTimes(2);
      expect(tauriMock.setDirtyFileCount).toHaveBeenLastCalledWith(1);
      state().editFileBuffer(a, 'xyz');
      await flush();
      expect(tauriMock.setDirtyFileCount).toHaveBeenCalledTimes(2);
      error.mockRestore();
    });

    it('reports the dirty file count once when the store starts', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.resetModules();
      await import('./index');
      expect(tauriMock.setDirtyFileCount).toHaveBeenCalledTimes(1);
      expect(tauriMock.setDirtyFileCount).toHaveBeenCalledWith(0);
      await flush();
      error.mockRestore();
    });

    it('saves several files and reports which ones failed and why', async () => {
      const a = await openBuffer('src/a.ts');
      const b = await openBuffer('src/b.ts');
      const c = await openBuffer('src/c.ts');
      const d = await openBuffer('src/d.ts');
      state().editFileBuffer(a, 'a2');
      state().editFileBuffer(b, 'b2');
      state().editFileBuffer(d, 'd2');
      tauriMock.writeProjectFile.mockImplementation((_projectId: number, path: string) => {
        if (path === 'src/b.ts') return Promise.reject(conflict);
        if (path === 'src/d.ts') return Promise.reject({ code: 'io', message: 'disk full' });
        return Promise.resolve('v2');
      });
      tauriMock.projectFileVersion.mockResolvedValue('v9');
      await expect(state().saveDirtyFiles([a, b, c, d])).resolves.toEqual([
        { tabId: b, path: 'src/b.ts', result: 'conflict' },
        { tabId: d, path: 'src/d.ts', result: 'error' },
      ]);
      expect(isFileDirty(buffer(a))).toBe(false);
      expect(buffer(b)).toMatchObject({ content: 'b2', disk: 'changed' });
      state().editFileBuffer(c, 'c2');
      await expect(state().saveDirtyFiles([a, c])).resolves.toEqual([]);
      expect(isFileDirty(buffer(c))).toBe(false);
    });

    it('counts only ready text buffers with unsaved content as dirty', () => {
      const base: FileBuffer = {
        tabId: 't', projectId: 1, path: 'a.txt', status: 'ready', view: { kind: 'text' },
        content: 'x', savedContent: 'y', eol: 'lf', hasBom: false, version: 'v1',
        mode: 'edit', saveStatus: 'idle', disk: 'same',
      };
      expect(isFileDirty(base)).toBe(true);
      expect(isFileDirty({ ...base, savedContent: 'x' })).toBe(false);
      expect(isFileDirty({ ...base, status: 'loading' })).toBe(false);
      expect(isFileDirty({ ...base, status: 'error' })).toBe(false);
      expect(isFileDirty({ ...base, view: { kind: 'image', dataUrl: 'data:' } })).toBe(false);
      expect(isFileDirty({ ...base, view: { kind: 'binary', size: 1 } })).toBe(false);
      expect(isFileDirty({ ...base, view: { kind: 'tooLarge', size: 1 } })).toBe(false);
      expect(isFileDirty({ ...base, savedContent: 'x', disk: 'deleted', version: null })).toBe(true);
      expect(isFileDirty({ ...base, content: '', savedContent: '', disk: 'deleted', version: null })).toBe(false);
    });
  });
});
