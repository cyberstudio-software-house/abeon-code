import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FileContent } from '../../types';

const tauriMock = vi.hoisted(() => ({
  listProjectDir: vi.fn(),
  watchProjectDir: vi.fn(),
  unwatchProjectDir: vi.fn(),
  readProjectFile: vi.fn(),
  writeProjectFile: vi.fn(),
  projectFileVersion: vi.fn(),
  setDirtyFileCount: vi.fn(),
}));

vi.mock('../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, ...tauriMock } };
});

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

vi.mock('./CodeEditor', () => ({
  CodeEditor: (props: { value: string; path: string; onChange: (value: string) => void; onSave: () => void; focused: boolean; focusToken?: number }) => (
    <div data-testid="editor-mock" data-path={props.path} data-focused={String(props.focused)} data-focus-token={String(props.focusToken)}>
      <textarea aria-label="editor" value={props.value} onChange={(event) => props.onChange(event.target.value)} />
      <button type="button" onClick={props.onSave}>mock-save</button>
    </div>
  ),
}));

import { toast } from 'sonner';
import { useStore } from '../../store';
import { fileName, fileTabId, isMarkdownPath } from '../../lib/fileText';
import type { Tab } from '../../store/tabsSlice';
import { TabItem } from '../center/TabItem';
import { FileTabView } from './FileTabView';

type FileTab = Extract<Tab, { kind: 'file' }>;

const textFile = (content: string, version = 'v1'): FileContent => ({ kind: 'text', content, version, size: content.length });
const conflict = { code: 'conflict', message: 'conflict: a' };
const state = () => useStore.getState();

const makeTab = (path: string, projectId = 1): FileTab => ({
  kind: 'file', id: fileTabId(projectId, path), projectId, path, title: fileName(path),
});

async function open(path: string, file: FileContent, props: { visible?: boolean; focused?: boolean } = {}) {
  const tab = makeTab(path);
  useStore.setState((s) => ({ tabs: [...s.tabs, tab] }));
  tauriMock.readProjectFile.mockResolvedValueOnce(file);
  const view = render(<FileTabView tab={tab} visible={props.visible ?? true} focused={props.focused ?? true} />);
  await waitFor(() => expect(state().fileBuffers[tab.id]?.status).not.toBe('loading'));
  if (file.kind === 'text' && !isMarkdownPath(path)) await screen.findByLabelText('editor');
  return { tab, ...view };
}

const edit = (value: string) => fireEvent.change(screen.getByLabelText('editor'), { target: { value } });
const saveButton = () => screen.getByRole('button', { name: /^Zapisz/ });

describe('FileTabView', () => {
  beforeEach(() => {
    Object.values(tauriMock).forEach((mock) => mock.mockReset());
    tauriMock.watchProjectDir.mockResolvedValue(undefined);
    tauriMock.unwatchProjectDir.mockResolvedValue(undefined);
    tauriMock.listProjectDir.mockResolvedValue([]);
    tauriMock.writeProjectFile.mockResolvedValue('v2');
    tauriMock.projectFileVersion.mockResolvedValue('v1');
    tauriMock.setDirtyFileCount.mockResolvedValue(undefined);
    vi.mocked(toast.error).mockClear();
    useStore.setState({ tabs: [], activeTabId: null });
  });

  afterEach(() => {
    cleanup();
    Object.keys(state().fileBuffers).forEach((id) => state().dropFileBuffer(id));
    vi.useRealTimers();
  });

  it('loads the buffer on mount and renders a text file in the editor', async () => {
    await open('src/a.ts', textFile('hello\n'));
    expect(tauriMock.readProjectFile).toHaveBeenCalledWith(1, 'src/a.ts');
    expect(screen.getByLabelText('editor')).toHaveValue('hello\n');
    expect(screen.getByTestId('editor-mock')).toHaveAttribute('data-path', 'src/a.ts');
  });

  it('shows a loading message until the file arrives', async () => {
    const tab = makeTab('src/slow.ts');
    useStore.setState((s) => ({ tabs: [...s.tabs, tab] }));
    let resolveRead!: (file: FileContent) => void;
    tauriMock.readProjectFile.mockReturnValueOnce(new Promise<FileContent>((resolve) => { resolveRead = resolve; }));
    render(<FileTabView tab={tab} visible focused />);
    expect(screen.getByText('Wczytywanie…')).toBeInTheDocument();
    expect(screen.queryByLabelText('editor')).not.toBeInTheDocument();
    await act(async () => { resolveRead(textFile('x')); });
    expect(await screen.findByLabelText('editor')).toHaveValue('x');
  });

  it('shows the loading message while the lazy editor loads', async () => {
    const tab = makeTab('src/lazy.ts');
    useStore.setState((s) => ({ tabs: [...s.tabs, tab] }));
    tauriMock.readProjectFile.mockResolvedValueOnce(textFile('x'));
    render(<FileTabView tab={tab} visible focused />);
    expect(screen.getByText('Wczytywanie…')).toBeInTheDocument();
    expect(await screen.findByLabelText('editor')).toHaveValue('x');
  });

  it('focuses the editor only when the tab is visible and focused', async () => {
    const { unmount } = await open('src/a.ts', textFile('a'), { visible: false, focused: true });
    expect(screen.getByTestId('editor-mock')).toHaveAttribute('data-focused', 'false');
    unmount();
    state().dropFileBuffer(makeTab('src/a.ts').id);
    await open('src/a.ts', textFile('a'), { visible: true, focused: true });
    expect(screen.getByTestId('editor-mock')).toHaveAttribute('data-focused', 'true');
  });

  it('renders Markdown as a preview without the editor and switches to editing and back', async () => {
    await open('docs/readme.md', textFile('# Title\n\nbody text\n'));
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.queryByLabelText('editor')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Podgląd' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edytuj' }));
    expect(await screen.findByLabelText('editor')).toHaveValue('# Title\n\nbody text\n');
    expect(screen.queryByRole('button', { name: 'Edytuj' })).not.toBeInTheDocument();

    edit('# Edited heading\n');
    fireEvent.click(screen.getByRole('button', { name: 'Podgląd' }));
    expect(screen.queryByLabelText('editor')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Edited heading' })).toBeInTheDocument();
    expect(screen.getByText('Niezapisane zmiany')).toBeInTheDocument();
  });

  it('does not offer the preview switch for a plain text file', async () => {
    await open('src/a.ts', textFile('a'));
    expect(screen.queryByRole('button', { name: 'Edytuj' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Podgląd' })).not.toBeInTheDocument();
  });

  it('keeps the save button disabled while clean and saves on click once edited', async () => {
    await open('src/a.ts', textFile('hello\n'));
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText('Ctrl+S')).toBeInTheDocument();
    edit('mine\n');
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(tauriMock.writeProjectFile).toHaveBeenCalledWith(1, 'src/a.ts', 'mine\n', 'v1', false));
    await waitFor(() => expect(state().fileBuffers[makeTab('src/a.ts').id].saveStatus).toBe('saved'));
  });

  it('shows the unsaved changes label while dirty and the saving label during a save', async () => {
    await open('src/a.ts', textFile('hello\n'));
    expect(screen.queryByText('Niezapisane zmiany')).not.toBeInTheDocument();
    edit('mine\n');
    expect(screen.getByText('Niezapisane zmiany')).toBeInTheDocument();
    let finishWrite!: (version: string) => void;
    tauriMock.writeProjectFile.mockReturnValueOnce(new Promise<string>((resolve) => { finishWrite = resolve; }));
    fireEvent.click(saveButton());
    expect(await screen.findByText('Zapisywanie…')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    await act(async () => { finishWrite('v2'); });
    expect(await screen.findByText('Zapisano')).toBeInTheDocument();
  });

  it('shows Zapisano for two seconds after a save', async () => {
    await open('src/a.ts', textFile('hello\n'));
    const id = makeTab('src/a.ts').id;
    vi.useFakeTimers();
    act(() => {
      useStore.setState((s) => ({ fileBuffers: { ...s.fileBuffers, [id]: { ...s.fileBuffers[id], saveStatus: 'saved' } } }));
    });
    expect(screen.getByText('Zapisano')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1900); });
    expect(screen.getByText('Zapisano')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByText('Zapisano')).not.toBeInTheDocument();
  });

  it('clears the saved timer on unmount', async () => {
    const { unmount } = await open('src/a.ts', textFile('hello\n'));
    const id = makeTab('src/a.ts').id;
    vi.useFakeTimers();
    act(() => {
      useStore.setState((s) => ({ fileBuffers: { ...s.fileBuffers, [id]: { ...s.fileBuffers[id], saveStatus: 'saved' } } }));
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the save error text', async () => {
    await open('src/a.ts', textFile('hello\n'));
    edit('mine\n');
    tauriMock.writeProjectFile.mockRejectedValueOnce({ code: 'io', message: 'disk full' });
    fireEvent.click(saveButton());
    expect(await screen.findByText('disk full')).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('saves from the editor shortcut callback', async () => {
    await open('src/a.ts', textFile('hello\n'));
    edit('mine\n');
    fireEvent.click(screen.getByRole('button', { name: 'mock-save' }));
    await waitFor(() => expect(tauriMock.writeProjectFile).toHaveBeenCalledTimes(1));
  });

  it('offers to reload or keep my edits when the file changed on disk', async () => {
    const { tab } = await open('src/a.ts', textFile('hello\n'));
    edit('mine\n');
    act(() => {
      useStore.setState((s) => ({ fileBuffers: { ...s.fileBuffers, [tab.id]: { ...s.fileBuffers[tab.id], disk: 'changed' } } }));
    });
    expect(screen.getByText('Plik zmienił się na dysku')).toBeInTheDocument();

    tauriMock.readProjectFile.mockResolvedValueOnce(textFile('theirs\n', 'v7'));
    fireEvent.click(screen.getByRole('button', { name: 'Wczytaj ponownie' }));
    await waitFor(() => expect(screen.getByLabelText('editor')).toHaveValue('theirs\n'));
    expect(screen.queryByText('Plik zmienił się na dysku')).not.toBeInTheDocument();
    expect(state().fileBuffers[tab.id]).toMatchObject({ disk: 'same', version: 'v7' });
  });

  it('keeps my edits on "Zostaw moje"', async () => {
    const { tab } = await open('src/a.ts', textFile('hello\n'));
    edit('mine\n');
    act(() => {
      useStore.setState((s) => ({ fileBuffers: { ...s.fileBuffers, [tab.id]: { ...s.fileBuffers[tab.id], disk: 'changed' } } }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Zostaw moje' }));
    expect(screen.queryByText('Plik zmienił się na dysku')).not.toBeInTheDocument();
    expect(state().fileBuffers[tab.id]).toMatchObject({ disk: 'same', content: 'mine\n' });
    expect(screen.getByLabelText('editor')).toHaveValue('mine\n');
  });

  it('toasts when reloading fails', async () => {
    const { tab } = await open('src/a.ts', textFile('hello\n'));
    edit('mine\n');
    act(() => {
      useStore.setState((s) => ({ fileBuffers: { ...s.fileBuffers, [tab.id]: { ...s.fileBuffers[tab.id], disk: 'changed' } } }));
    });
    tauriMock.readProjectFile.mockRejectedValueOnce({ code: 'io', message: 'boom' });
    fireEvent.click(screen.getByRole('button', { name: 'Wczytaj ponownie' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nie udało się wczytać pliku ponownie'));
  });

  it('shows the deleted bar and saving recreates the file', async () => {
    const { tab } = await open('src/a.ts', textFile('hello\n'));
    edit('mine\n');
    act(() => {
      useStore.setState((s) => ({ fileBuffers: { ...s.fileBuffers, [tab.id]: { ...s.fileBuffers[tab.id], disk: 'deleted', version: null } } }));
    });
    expect(screen.getByText('Plik został usunięty')).toBeInTheDocument();
    expect(screen.queryByText('Plik zmienił się na dysku')).not.toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(tauriMock.writeProjectFile).toHaveBeenCalledWith(1, 'src/a.ts', 'mine\n', null, false));
    await waitFor(() => expect(screen.queryByText('Plik został usunięty')).not.toBeInTheDocument());
  });

  it('keeps the save button enabled for an emptied deleted file', async () => {
    const { tab } = await open('src/empty.txt', textFile(''));
    act(() => {
      useStore.setState((s) => ({ fileBuffers: { ...s.fileBuffers, [tab.id]: { ...s.fileBuffers[tab.id], disk: 'deleted', version: null } } }));
    });
    expect(saveButton()).toBeEnabled();
  });

  describe('save conflict', () => {
    const openConflict = async () => {
      const { tab } = await open('src/a.ts', textFile('hello\n'));
      edit('mine\n');
      tauriMock.writeProjectFile.mockRejectedValueOnce(conflict);
      tauriMock.projectFileVersion.mockResolvedValueOnce('v2');
      fireEvent.click(saveButton());
      const dialog = await screen.findByRole('dialog');
      return { tab, dialog };
    };

    it('opens the dialog and overwrites with force', async () => {
      const { tab, dialog } = await openConflict();
      expect(within(dialog).getByRole('heading', { name: 'Plik zmienił się na dysku' })).toBeInTheDocument();
      expect(within(dialog).getByText('Zapis nadpisze zmiany wprowadzone poza edytorem.')).toBeInTheDocument();
      tauriMock.writeProjectFile.mockResolvedValueOnce('v3');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Nadpisz' }));
      await waitFor(() => expect(tauriMock.writeProjectFile).toHaveBeenLastCalledWith(1, 'src/a.ts', 'mine\n', 'v1', true));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(state().fileBuffers[tab.id]).toMatchObject({ savedContent: 'mine\n', disk: 'same' }));
    });

    it('reloads from the dialog', async () => {
      const { dialog } = await openConflict();
      tauriMock.readProjectFile.mockResolvedValueOnce(textFile('theirs\n', 'v2'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Wczytaj ponownie' }));
      await waitFor(() => expect(screen.getByLabelText('editor')).toHaveValue('theirs\n'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('focuses Anuluj when it opens and hands the keyboard back to the editor when it closes', async () => {
      const { dialog } = await openConflict();
      expect(within(dialog).getByRole('button', { name: 'Anuluj' })).toHaveFocus();
      const before = screen.getByTestId('editor-mock').getAttribute('data-focus-token');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Anuluj' }));
      expect(screen.getByTestId('editor-mock').getAttribute('data-focus-token')).not.toBe(before);
    });

    it('closes on Escape and releases its key listener once closed', async () => {
      const { dialog } = await openConflict();
      const remove = vi.spyOn(document, 'removeEventListener');
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(dialog).not.toBeInTheDocument();
      expect(remove.mock.calls.some(([type]) => type === 'keydown')).toBe(true);
      remove.mockRestore();
    });

    it('cancels without writing', async () => {
      const { dialog } = await openConflict();
      tauriMock.writeProjectFile.mockClear();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Anuluj' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(tauriMock.writeProjectFile).not.toHaveBeenCalled();
      expect(screen.getByLabelText('editor')).toHaveValue('mine\n');
    });

    it('opens the dialog for a conflict raised by the editor shortcut too', async () => {
      await open('src/a.ts', textFile('hello\n'));
      edit('mine\n');
      tauriMock.writeProjectFile.mockRejectedValueOnce(conflict);
      tauriMock.projectFileVersion.mockResolvedValueOnce('v2');
      fireEvent.click(screen.getByRole('button', { name: 'mock-save' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });
  });

  it('shows a message with the size for a file that is too large', async () => {
    await open('big.log', { kind: 'tooLarge', version: 'v1', size: 1_572_864 });
    expect(screen.getByText('Plik jest za duży, aby go otworzyć (1.5 MB)')).toBeInTheDocument();
    expect(screen.queryByLabelText('editor')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Zapisz/ })).not.toBeInTheDocument();
  });

  it('shows a message with the size for a binary file', async () => {
    await open('tool.bin', { kind: 'binary', version: 'v1', size: 2048 });
    expect(screen.getByText('Plik binarny (2.0 KB)')).toBeInTheDocument();
  });

  it('formats small sizes in bytes', async () => {
    await open('tool.bin', { kind: 'binary', version: 'v1', size: 512 });
    expect(screen.getByText('Plik binarny (512 B)')).toBeInTheDocument();
  });

  it('renders an image fitted into the tab with the file name as alt text', async () => {
    await open('assets/logo.png', { kind: 'image', data_url: 'data:image/png;base64,AAAA', version: 'v1', size: 4 });
    const image = screen.getByRole('img', { name: 'logo.png' });
    expect(image).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(image.className).toContain('object-contain');
    expect(screen.queryByLabelText('editor')).not.toBeInTheDocument();
  });

  it.each([
    ['an image', 'assets/logo.png', { kind: 'image', data_url: 'data:image/png;base64,AAAA', version: 'v1', size: 4 }],
    ['a binary file', 'tool.bin', { kind: 'binary', version: 'v1', size: 2048 }],
    ['a too large file', 'big.log', { kind: 'tooLarge', version: 'v1', size: 1_572_864 }],
  ] as const)('shows the deleted bar for %s without offering to save it', async (_label, path, file) => {
    const { tab } = await open(path, file);
    expect(screen.queryByText('Plik został usunięty')).not.toBeInTheDocument();
    act(() => {
      useStore.setState((s) => ({ fileBuffers: { ...s.fileBuffers, [tab.id]: { ...s.fileBuffers[tab.id], disk: 'deleted', version: null } } }));
    });
    expect(screen.getByText('Plik został usunięty')).toBeInTheDocument();
    expect(screen.queryByText('Zapis utworzy go ponownie.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Zapisz/ })).not.toBeInTheDocument();
  });

  it('shows the load error with a retry that loads the file again', async () => {
    const tab = makeTab('src/a.ts');
    useStore.setState((s) => ({ tabs: [...s.tabs, tab] }));
    tauriMock.readProjectFile.mockRejectedValueOnce({ code: 'io', message: 'denied' });
    render(<FileTabView tab={tab} visible focused />);
    expect(await screen.findByText('Nie udało się otworzyć pliku')).toBeInTheDocument();
    tauriMock.readProjectFile.mockResolvedValueOnce(textFile('back\n'));
    fireEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    expect(await screen.findByLabelText('editor')).toHaveValue('back\n');
    expect(tauriMock.readProjectFile).toHaveBeenCalledTimes(2);
  });

  it('shows the dirty marker after the tab title', async () => {
    const { tab } = await open('src/a.ts', textFile('hello\n'));
    const noop = () => undefined;
    render(
      <TabItem
        tab={tab} active paneFocused editing={false} inputRef={{ current: null }}
        onActivate={noop} onMiddleClick={noop} onContextMenu={noop}
        onBeginRename={noop} onCommitRename={noop} onCancelRename={noop} onClose={noop}
      />,
    );
    const item = document.querySelector(`[data-tab-id="${tab.id}"]`) as HTMLElement;
    expect(within(item).queryByText('●')).not.toBeInTheDocument();
    edit('mine\n');
    expect(within(item).getByText('●')).toBeInTheDocument();
    expect(within(item).getByText('a.ts')).toBeInTheDocument();
  });
});
