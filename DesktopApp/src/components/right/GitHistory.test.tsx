import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitBranch, GitCommit, GitCommitDetail, GitRepo } from '../../types';

vi.mock('../../lib/tauri', () => ({
  tauri: {
    gitBranches: vi.fn(),
    gitLog: vi.fn(),
    gitCommitDetail: vi.fn(),
    gitDiffCommitFile: vi.fn(),
  },
}));

import { tauri } from '../../lib/tauri';
import { GitHistory } from './GitHistory';

const BRANCHES: GitBranch[] = [
  { name: 'feature', isRemote: false, isHead: false },
  { name: 'main', isRemote: false, isHead: true },
  { name: 'origin/main', isRemote: true, isHead: false },
];

function commit(i: number): GitCommit {
  const hash = `${i}`.padEnd(40, 'a');
  return { hash, shortHash: hash.slice(0, 7), subject: `commit ${i}`, author: 'Ala', timestamp: 1_700_000_000 };
}

const REPO: GitRepo = { label: '.', branch: 'main', ahead: 0, behind: 0, files: [] };
const SUB_A: GitRepo = { ...REPO, label: 'alpha' };
const SUB_B: GitRepo = { ...REPO, label: 'beta' };

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mocked(tauri.gitBranches).mockResolvedValue(BRANCHES);
  mocked(tauri.gitLog).mockResolvedValue([commit(1), commit(2)]);
});

describe('GitHistory', () => {
  it('loads the HEAD branch log and renders commit rows', async () => {
    render(<GitHistory projectId={1} repos={[REPO]} reloadToken={0} />);
    await waitFor(() => expect(tauri.gitLog).toHaveBeenCalledWith(1, '.', 'main', 0, 50));
    expect(await screen.findByText('commit 1')).toBeInTheDocument();
    expect(screen.getByText(commit(1).shortHash)).toBeInTheDocument();
    expect(screen.getAllByText('Ala').length).toBe(2);
  });

  it('groups branches into local and remote optgroups', async () => {
    render(<GitHistory projectId={1} repos={[REPO]} reloadToken={0} />);
    const select = await screen.findByLabelText('Gałąź');
    const groups = within(select).getAllByRole('group');
    expect(groups.map(g => g.getAttribute('label'))).toEqual(['Lokalne', 'Zdalne']);
    expect(within(groups[1]).getByText('origin/main')).toBeInTheDocument();
    expect((select as HTMLSelectElement).value).toBe('main');
  });

  it('refetches the log when the branch changes', async () => {
    render(<GitHistory projectId={1} repos={[REPO]} reloadToken={0} />);
    const select = await screen.findByLabelText('Gałąź');
    fireEvent.change(select, { target: { value: 'feature' } });
    await waitFor(() => expect(tauri.gitLog).toHaveBeenCalledWith(1, '.', 'feature', 0, 50));
  });

  it('hides the repo selector for a single repo', async () => {
    render(<GitHistory projectId={1} repos={[REPO]} reloadToken={0} />);
    await screen.findByLabelText('Gałąź');
    expect(screen.queryByLabelText('Repozytorium')).not.toBeInTheDocument();
  });

  it('shows a repo selector for multiple repos and reloads branches on change', async () => {
    render(<GitHistory projectId={1} repos={[SUB_A, SUB_B]} reloadToken={0} />);
    await waitFor(() => expect(tauri.gitBranches).toHaveBeenCalledWith(1, 'alpha'));
    fireEvent.change(screen.getByLabelText('Repozytorium'), { target: { value: 'beta' } });
    await waitFor(() => expect(tauri.gitBranches).toHaveBeenCalledWith(1, 'beta'));
    await waitFor(() => expect(tauri.gitLog).toHaveBeenCalledWith(1, 'beta', 'main', 0, 50));
  });

  it('appends the next page on "Załaduj więcej" and hides it on a short page', async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => commit(i + 1));
    mocked(tauri.gitLog).mockResolvedValueOnce(firstPage).mockResolvedValueOnce([commit(51)]);
    render(<GitHistory projectId={1} repos={[REPO]} reloadToken={0} />);
    const more = await screen.findByRole('button', { name: 'Załaduj więcej' });
    fireEvent.click(more);
    await waitFor(() => expect(tauri.gitLog).toHaveBeenCalledWith(1, '.', 'main', 50, 50));
    expect(await screen.findByText('commit 51')).toBeInTheDocument();
    expect(screen.getByText('commit 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Załaduj więcej' })).not.toBeInTheDocument();
  });

  it('shows an empty state when the branch has no commits', async () => {
    mocked(tauri.gitLog).mockResolvedValue([]);
    render(<GitHistory projectId={1} repos={[REPO]} reloadToken={0} />);
    expect(await screen.findByText('Brak commitów')).toBeInTheDocument();
  });

  it('shows an error when loading fails', async () => {
    mocked(tauri.gitLog).mockRejectedValue('kaput');
    render(<GitHistory projectId={1} repos={[REPO]} reloadToken={0} />);
    expect(await screen.findByText(/kaput/)).toBeInTheDocument();
  });

  it('reloads when reloadToken changes', async () => {
    const { rerender } = render(<GitHistory projectId={1} repos={[REPO]} reloadToken={0} />);
    await waitFor(() => expect(tauri.gitLog).toHaveBeenCalledTimes(1));
    rerender(<GitHistory projectId={1} repos={[REPO]} reloadToken={1} />);
    await waitFor(() => expect(tauri.gitLog).toHaveBeenCalledTimes(2));
  });

  it('opens the commit diff dialog on row click', async () => {
    const detail: GitCommitDetail = {
      commit: commit(1),
      body: 'commit 1\n\nlonger body',
      files: [{ path: 'a.txt', status: 'M', staged: true, additions: 1, deletions: 1 }],
    };
    mocked(tauri.gitCommitDetail).mockResolvedValue(detail);
    mocked(tauri.gitDiffCommitFile).mockResolvedValue({ kind: 'text', hunks: [] });
    render(<GitHistory projectId={1} repos={[REPO]} reloadToken={0} />);
    fireEvent.click(await screen.findByText('commit 1'));
    await waitFor(() => expect(tauri.gitCommitDetail).toHaveBeenCalledWith(1, '.', commit(1).hash));
    expect(await screen.findByText('longer body')).toBeInTheDocument();
    await waitFor(() => expect(tauri.gitDiffCommitFile).toHaveBeenCalledWith(1, '.', commit(1).hash, 'a.txt'));
  });
});
