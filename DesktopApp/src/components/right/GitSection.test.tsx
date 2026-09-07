import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitStatus } from '../../types';

type MockState = Record<string, unknown>;
let mockState: MockState;

vi.mock('../../store', () => ({
  useStore: (sel: (s: MockState) => unknown) => sel(mockState),
}));

vi.mock('../../lib/tauri', () => ({
  tauri: {
    gitDiffFile: vi.fn().mockResolvedValue({ kind: 'text', hunks: [] }),
  },
}));

const historyProps = vi.fn();
const historyMounted = vi.fn();
vi.mock('./GitHistory', async () => {
  const { useEffect } = await import('react');
  return {
    GitHistory: (props: Record<string, unknown>) => {
      historyProps(props);
      useEffect(() => { historyMounted(); }, []);
      return <div>history-stub</div>;
    },
  };
});

import { GitSection } from './GitSection';
import { tauri } from '../../lib/tauri';

const STATUS: GitStatus = {
  isRepo: true,
  repos: [{
    label: '.',
    branch: 'main',
    ahead: 0,
    behind: 0,
    files: [{ path: 'a.txt', status: 'M', staged: false, additions: 1, deletions: 0 }],
  }],
};

function baseState(overrides: Partial<MockState> = {}): MockState {
  return {
    tabs: [{ id: 'tab-1', projectId: 1 }],
    activeTabId: 'tab-1',
    gitByProject: { 1: STATUS },
    refreshGit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('GitSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState = baseState();
  });

  it('shows the changes tab by default', () => {
    render(<GitSection />);
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.queryByText('history-stub')).not.toBeInTheDocument();
  });

  it('switches to the history tab', () => {
    render(<GitSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Historia' }));
    expect(screen.getByText('history-stub')).toBeInTheDocument();
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
    expect(historyProps).toHaveBeenCalledWith(expect.objectContaining({ projectId: 1, repos: STATUS.repos }));
  });

  it('refresh button reloads history when the history tab is active', async () => {
    render(<GitSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Historia' }));
    const lastProps = () => historyProps.mock.calls[historyProps.mock.calls.length - 1][0];
    const before = lastProps().reloadToken;
    fireEvent.click(screen.getByRole('button', { name: 'Odśwież' }));
    await waitFor(() => expect(lastProps().reloadToken).not.toBe(before));
  });

  it('remounts history when the active project changes', async () => {
    const { rerender } = render(<GitSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Historia' }));
    expect(historyMounted).toHaveBeenCalledTimes(1);
    mockState = baseState({
      tabs: [{ id: 'tab-2', projectId: 2 }],
      activeTabId: 'tab-2',
      gitByProject: { 2: STATUS },
    });
    rerender(<GitSection />);
    expect(historyMounted).toHaveBeenCalledTimes(2);
  });

  it('does not refetch an open diff when the section re-renders', async () => {
    const { rerender } = render(<GitSection />);
    fireEvent.click(screen.getByText('a.txt'));
    await waitFor(() => expect(tauri.gitDiffFile).toHaveBeenCalledTimes(1));
    mockState = baseState({ gitByProject: { 1: { ...STATUS } } });
    rerender(<GitSection />);
    await new Promise(r => setTimeout(r, 20));
    expect(tauri.gitDiffFile).toHaveBeenCalledTimes(1);
  });
});
