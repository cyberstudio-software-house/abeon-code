import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry, GitStatus } from '../../types';

const tauriMock = vi.hoisted(() => ({
  listProjectDir: vi.fn(),
  searchProjectFiles: vi.fn(),
  watchProjectDir: vi.fn(),
  unwatchProjectDir: vi.fn(),
  ptyWrite: vi.fn(),
  writeClipboardText: vi.fn(),
}));
const toastMock = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, ...tauriMock } };
});
vi.mock('sonner', () => ({ toast: toastMock }));

import { useStore } from '../../store';
import { FilesPanel } from './FilesPanel';

const entry = (name: string, kind: 'dir' | 'file' = 'file', ignored = false): FileEntry => ({ name, kind, ignored });
const ready = (entries: FileEntry[]) => ({ status: 'ready' as const, entries });

const openFileTab = vi.fn();
const closeFilesPanel = vi.fn();

function seed(listings: Record<string, ReturnType<typeof ready> | { status: 'error' | 'loading'; entries: FileEntry[] }>, expanded: string[] = [], extra: Record<string, unknown> = {}) {
  useStore.setState({
    filesPanelOpen: true,
    tabs: [{ kind: 'terminal', id: 'tab-1', projectId: 1, title: 't' }],
    activeTabId: 'tab-1',
    fileTrees: { 1: { expanded, listings } },
    fileSearch: { query: '', status: 'idle', results: [], truncated: false, selected: 0 },
    gitByProject: {},
    activeAgentPtyId: null,
    openFileTab,
    closeFilesPanel,
    ...extra,
  });
}

const encode = (text: string) => btoa(unescape(encodeURIComponent(text)));

describe('FilesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMock.listProjectDir.mockResolvedValue([]);
    tauriMock.searchProjectFiles.mockResolvedValue({ results: [], truncated: false });
    tauriMock.watchProjectDir.mockResolvedValue(undefined);
    tauriMock.unwatchProjectDir.mockResolvedValue(undefined);
    tauriMock.ptyWrite.mockResolvedValue(undefined);
    tauriMock.writeClipboardText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => useStore.getState().closeFilesPanel());
  });

  it('renders the header, a focused search box and a close button', () => {
    seed({ '': ready([]) });
    render(<FilesPanel />);
    expect(screen.getByText('Pliki')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Szukaj pliku…')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Zamknij pliki' }));
    expect(closeFilesPanel).toHaveBeenCalledTimes(1);
  });

  it('renders directories before files and dims ignored entries', () => {
    seed({ '': ready([entry('src', 'dir'), entry('target', 'dir', true), entry('a.ts'), entry('.env', 'file', true)]) });
    render(<FilesPanel />);
    const rows = screen.getAllByRole('treeitem');
    expect(rows.map((row) => row.textContent)).toEqual(['src', 'target', 'a.ts', '.env']);
    expect(rows[1]).toHaveClass('opacity-50');
    expect(rows[3]).toHaveClass('opacity-50');
    expect(rows[0]).not.toHaveClass('opacity-50');
    expect(rows[0]).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a file tab when a file is clicked', () => {
    seed({ '': ready([entry('src', 'dir')]), src: ready([entry('a.ts')]) }, ['src']);
    render(<FilesPanel />);
    fireEvent.click(screen.getByRole('treeitem', { name: /a\.ts/ }));
    expect(openFileTab).toHaveBeenCalledWith(1, 'src/a.ts');
  });

  it('opens a file with Enter on a focused row', () => {
    seed({ '': ready([entry('a.ts')]) });
    render(<FilesPanel />);
    fireEvent.keyDown(screen.getByRole('treeitem', { name: /a\.ts/ }), { key: 'Enter' });
    expect(openFileTab).toHaveBeenCalledWith(1, 'a.ts');
  });

  it('hides the children of collapsed directories and shows them when expanded', () => {
    const listings = { '': ready([entry('src', 'dir')]), src: ready([entry('a.ts')]) };
    seed(listings);
    const { unmount } = render(<FilesPanel />);
    expect(screen.queryByRole('treeitem', { name: /a\.ts/ })).not.toBeInTheDocument();
    unmount();
    seed(listings, ['src']);
    render(<FilesPanel />);
    expect(screen.getByRole('treeitem', { name: /a\.ts/ })).toHaveAttribute('aria-level', '2');
    expect(screen.getByRole('treeitem', { name: /src/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('expands a directory on click and loads it', async () => {
    tauriMock.listProjectDir.mockResolvedValue([entry('a.ts')]);
    seed({ '': ready([entry('src', 'dir')]) });
    render(<FilesPanel />);
    fireEvent.click(screen.getByRole('treeitem', { name: /src/ }));
    expect(await screen.findByRole('treeitem', { name: /a\.ts/ })).toBeInTheDocument();
    expect(tauriMock.listProjectDir).toHaveBeenCalledWith(1, 'src');
    fireEvent.click(screen.getByRole('treeitem', { name: /src/ }));
    expect(screen.queryByRole('treeitem', { name: /a\.ts/ })).not.toBeInTheDocument();
  });

  it('shows the git letter of a changed file, also in a nested repository', () => {
    const status: GitStatus = {
      isRepo: true,
      repos: [
        { label: '.', branch: 'main', ahead: 0, behind: 0, files: [{ path: 'a.ts', status: 'M', staged: false, additions: 0, deletions: 0 }] },
        { label: 'api', branch: 'main', ahead: 0, behind: 0, files: [{ path: 'b.ts', status: '?', staged: false, additions: 0, deletions: 0 }] },
      ],
    };
    seed({ '': ready([entry('api', 'dir'), entry('a.ts')]), api: ready([entry('b.ts')]) }, ['api'], { gitByProject: { 1: status } });
    render(<FilesPanel />);
    const changed = screen.getByRole('treeitem', { name: /a\.ts/ });
    expect(within(changed).getByText('M')).toHaveClass('text-accent');
    expect(within(screen.getByRole('treeitem', { name: /b\.ts/ })).getByText('?')).toHaveClass('text-muted');
  });

  it('highlights the entry of the active file tab', () => {
    seed({ '': ready([entry('a.ts'), entry('b.ts')]) }, [], {
      tabs: [{ kind: 'file', id: 'file:1:b.ts', projectId: 1, path: 'b.ts', title: 'b.ts' }],
      activeTabId: 'file:1:b.ts',
    });
    render(<FilesPanel />);
    expect(screen.getByRole('treeitem', { name: /b\.ts/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('treeitem', { name: /a\.ts/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('renders at most 2000 entries of a directory and says so', () => {
    const entries = Array.from({ length: 2001 }, (_, index) => entry(`f${String(index).padStart(4, '0')}.txt`));
    seed({ '': ready(entries) });
    render(<FilesPanel />);
    expect(screen.getAllByRole('treeitem')).toHaveLength(2000);
    expect(screen.getByText('pokazano pierwsze 2000')).toBeInTheDocument();
  });

  it('shows an error with a retry that reloads the directory', async () => {
    seed({ '': { status: 'error', entries: [] } });
    tauriMock.listProjectDir.mockResolvedValue([entry('a.ts')]);
    render(<FilesPanel />);
    expect(screen.getByText('Nie udało się wczytać katalogu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    expect(await screen.findByRole('treeitem', { name: /a\.ts/ })).toBeInTheDocument();
    expect(tauriMock.listProjectDir).toHaveBeenCalledWith(1, '');
    expect(screen.queryByText('Nie udało się wczytać katalogu')).not.toBeInTheDocument();
  });

  describe('search', () => {
    const type = (value: string) => fireEvent.change(screen.getByPlaceholderText('Szukaj pliku…'), { target: { value } });

    it('replaces the tree with a flat list showing the directory under each name', async () => {
      tauriMock.searchProjectFiles.mockResolvedValue({ results: ['src/lib/a.ts', 'b.ts'], truncated: false });
      seed({ '': ready([entry('src', 'dir')]) });
      render(<FilesPanel />);
      type('a');
      const first = await screen.findByRole('option', { name: /a\.ts/ });
      expect(tauriMock.searchProjectFiles).toHaveBeenCalledWith(1, 'a');
      expect(within(first).getByText('src/lib')).toBeInTheDocument();
      expect(screen.getAllByRole('option')).toHaveLength(2);
      expect(screen.queryByRole('treeitem')).not.toBeInTheDocument();
    });

    it('opens the second result with ArrowDown and Enter', async () => {
      tauriMock.searchProjectFiles.mockResolvedValue({ results: ['a.ts', 'src/b.ts'], truncated: false });
      seed({ '': ready([]) });
      render(<FilesPanel />);
      type('ts');
      await screen.findByRole('option', { name: /b\.ts/ });
      const input = screen.getByPlaceholderText('Szukaj pliku…');
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(screen.getByRole('option', { name: /b\.ts/ })).toHaveAttribute('aria-selected', 'true');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(openFileTab).toHaveBeenCalledWith(1, 'src/b.ts');
    });

    it('opens a result on click', async () => {
      tauriMock.searchProjectFiles.mockResolvedValue({ results: ['a.ts'], truncated: false });
      seed({ '': ready([]) });
      render(<FilesPanel />);
      type('a');
      fireEvent.click(await screen.findByRole('option', { name: /a\.ts/ }));
      expect(openFileTab).toHaveBeenCalledWith(1, 'a.ts');
    });

    it('clears the query on Escape and brings the tree back', async () => {
      tauriMock.searchProjectFiles.mockResolvedValue({ results: ['a.ts'], truncated: false });
      seed({ '': ready([entry('src', 'dir')]) });
      render(<FilesPanel />);
      type('a');
      await screen.findByRole('option', { name: /a\.ts/ });
      fireEvent.keyDown(screen.getByPlaceholderText('Szukaj pliku…'), { key: 'Escape' });
      expect(screen.getByPlaceholderText('Szukaj pliku…')).toHaveValue('');
      expect(screen.getByRole('treeitem', { name: /src/ })).toBeInTheDocument();
      expect(screen.queryByRole('option')).not.toBeInTheDocument();
    });

    it('says when nothing matches', async () => {
      seed({ '': ready([]) });
      render(<FilesPanel />);
      type('zzz');
      expect(await screen.findByText('Brak wyników')).toBeInTheDocument();
    });

    it('says when the results were cut', async () => {
      tauriMock.searchProjectFiles.mockResolvedValue({ results: ['a.ts'], truncated: true });
      seed({ '': ready([]) });
      render(<FilesPanel />);
      type('a');
      expect(await screen.findByText('pokazano pierwsze 200')).toBeInTheDocument();
    });

    it('shows a failed search', async () => {
      tauriMock.searchProjectFiles.mockRejectedValue(new Error('boom'));
      seed({ '': ready([]) });
      render(<FilesPanel />);
      type('a');
      await waitFor(() => expect(screen.getByText('Nie udało się wyszukać plików')).toBeInTheDocument());
    });
  });

  describe('context menu', () => {
    const openMenu = (name: RegExp) => fireEvent.contextMenu(screen.getByRole('treeitem', { name }));

    it('copies the relative path', async () => {
      seed({ '': ready([entry('src', 'dir')]), src: ready([entry('a.ts')]) }, ['src']);
      render(<FilesPanel />);
      openMenu(/a\.ts/);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Kopiuj ścieżkę' }));
      await waitFor(() => expect(tauriMock.writeClipboardText).toHaveBeenCalledWith('src/a.ts'));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('disables inserting the path without an active session', () => {
      seed({ '': ready([entry('a.ts')]) });
      render(<FilesPanel />);
      openMenu(/a\.ts/);
      const item = screen.getByRole('menuitem', { name: 'Wstaw ścieżkę do sesji' });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute('title', 'Brak aktywnej sesji');
      fireEvent.click(item);
      expect(tauriMock.ptyWrite).not.toHaveBeenCalled();
    });

    it('types the path and one space into the active session', async () => {
      seed({ '': ready([entry('src', 'dir')]), src: ready([entry('a.ts')]) }, ['src'], { activeAgentPtyId: 'pty-1' });
      render(<FilesPanel />);
      openMenu(/a\.ts/);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Wstaw ścieżkę do sesji' }));
      await waitFor(() => expect(tauriMock.ptyWrite).toHaveBeenCalledWith('pty-1', encode('src/a.ts ')));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('closes on Escape and on an outside click', () => {
      seed({ '': ready([entry('a.ts')]) });
      render(<FilesPanel />);
      openMenu(/a\.ts/);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      openMenu(/a\.ts/);
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('offers the menu on search results too', async () => {
      tauriMock.searchProjectFiles.mockResolvedValue({ results: ['src/a.ts'], truncated: false });
      seed({ '': ready([]) });
      render(<FilesPanel />);
      fireEvent.change(screen.getByPlaceholderText('Szukaj pliku…'), { target: { value: 'a' } });
      fireEvent.contextMenu(await screen.findByRole('option', { name: /a\.ts/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Kopiuj ścieżkę' }));
      await waitFor(() => expect(tauriMock.writeClipboardText).toHaveBeenCalledWith('src/a.ts'));
    });
  });
});
