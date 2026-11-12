import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry, GitStatus } from '../../types';

const iconRenders = vi.hoisted(() => [] as string[]);
const tauriMock = vi.hoisted(() => ({
  listProjectDir: vi.fn().mockResolvedValue([]),
  watchProjectDir: vi.fn().mockResolvedValue(undefined),
  unwatchProjectDir: vi.fn().mockResolvedValue(undefined),
  setDirtyFileCount: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, ...tauriMock } };
});

vi.mock('../shared/Icon', () => ({
  Icon: ({ name }: { name: string }) => {
    iconRenders.push(name);
    return null;
  },
}));

import { useStore } from '../../store';
import { FilesPanel } from './FilesPanel';
import { FileTree } from './FileTree';

const entry = (name: string, kind: 'dir' | 'file' = 'file'): FileEntry => ({ name, kind, ignored: false });
const ready = (entries: FileEntry[]) => ({ status: 'ready' as const, entries });
const rowRenders = () => iconRenders.filter((name) => name === 'file' || name === 'folder').length;

const gitStatus = (files: { path: string; status: string }[]): GitStatus => ({
  isRepo: true,
  repos: [{ label: '.', branch: 'main', ahead: 0, behind: 0, files: files.map((file) => ({ ...file, staged: false, additions: 0, deletions: 0 })) }],
});

describe('FileTree rendering', () => {
  const realState = useStore.getState();
  const onContextMenu = vi.fn();

  beforeEach(() => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 'tab-1', projectId: 1, title: 't' }],
      activeTabId: 'tab-1',
      gitByProject: {},
      activeAgentPtyId: null,
      fileSearch: { query: '', status: 'idle', results: [], truncated: false, selected: 0 },
      fileTrees: {
        1: {
          expanded: ['src'],
          listings: { '': ready([entry('src', 'dir'), entry('a.ts'), entry('b.ts')]), src: ready([entry('c.ts')]) },
        },
      },
    });
    iconRenders.length = 0;
  });

  afterEach(() => {
    useStore.setState({
      closeFilesPanel: realState.closeFilesPanel,
      fileTrees: {},
      gitByProject: {},
    });
  });

  it('re-renders no row for a store change in a directory it does not show', () => {
    render(<FileTree projectId={1} onContextMenu={onContextMenu} />);
    expect(rowRenders()).toBe(4);
    iconRenders.length = 0;

    act(() => {
      useStore.setState((s) => ({
        fileTrees: { 1: { ...s.fileTrees[1], listings: { ...s.fileTrees[1].listings, lib: ready([entry('z.ts')]) } } },
      }));
    });

    expect(rowRenders()).toBe(0);
  });

  it('re-renders only the row whose git status changed on a git refresh', () => {
    render(<FileTree projectId={1} onContextMenu={onContextMenu} />);
    iconRenders.length = 0;

    act(() => { useStore.setState({ gitByProject: { 1: gitStatus([{ path: 'a.ts', status: 'M' }]) } }); });

    expect(rowRenders()).toBe(1);
    expect(screen.getByRole('treeitem', { name: /a\.ts/ })).toHaveTextContent('M');
  });

  it('re-renders no row when the context menu opens and closes', () => {
    useStore.setState({ filesPanelOpen: true, closeFilesPanel: vi.fn() });
    render(<FilesPanel />);
    iconRenders.length = 0;

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: /a\.ts/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    expect(rowRenders()).toBe(0);
  });

  it('still renders a newly expanded directory and the selection of the active file', () => {
    render(<FileTree projectId={1} onContextMenu={onContextMenu} />);
    act(() => {
      useStore.setState((s) => ({
        tabs: [...s.tabs, { kind: 'file', id: 'file:1:src/c.ts', projectId: 1, path: 'src/c.ts', title: 'c.ts' }],
        activeTabId: 'file:1:src/c.ts',
      }));
    });
    expect(screen.getByRole('treeitem', { name: /c\.ts/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('treeitem', { name: /a\.ts/ })).toHaveAttribute('aria-selected', 'false');
  });
});
