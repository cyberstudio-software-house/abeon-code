import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DiffDialog } from './DiffDialog';
import type { GitFile, DiffResult } from '../../types';

vi.mock('../../lib/tauri', () => ({
  tauri: {
    gitDiffFile: vi.fn(),
  },
}));

import { tauri } from '../../lib/tauri';

const FILES: GitFile[] = [
  { path: 'a.txt', status: 'M', staged: false, additions: 1, deletions: 1 },
  { path: 'b.txt', status: 'A', staged: true, additions: 5, deletions: 0 },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DiffDialog', () => {
  it('shows loading state initially', () => {
    (tauri.gitDiffFile as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<DiffDialog projectId={1} repoLabel="." files={FILES} initialFilePath="a.txt" onClose={() => {}} />);
    expect(screen.getByText(/Wczytywanie diffa/i)).toBeInTheDocument();
  });

  it('renders binary message', async () => {
    const res: DiffResult = { kind: 'binary' };
    (tauri.gitDiffFile as ReturnType<typeof vi.fn>).mockResolvedValue(res);
    render(<DiffDialog projectId={1} repoLabel="." files={FILES} initialFilePath="a.txt" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Plik binarny/i)).toBeInTheDocument());
  });

  it('renders too-large message', async () => {
    const res: DiffResult = { kind: 'tooLarge', size: 3_000_000 };
    (tauri.gitDiffFile as ReturnType<typeof vi.fn>).mockResolvedValue(res);
    render(<DiffDialog projectId={1} repoLabel="." files={FILES} initialFilePath="a.txt" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Plik za du/i)).toBeInTheDocument());
  });

  it('renders empty-changes message when hunks empty', async () => {
    const res: DiffResult = { kind: 'text', hunks: [] };
    (tauri.gitDiffFile as ReturnType<typeof vi.fn>).mockResolvedValue(res);
    render(<DiffDialog projectId={1} repoLabel="." files={FILES} initialFilePath="a.txt" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Brak zmian tekstowych/i)).toBeInTheDocument());
  });

  it('calls onClose on Escape', async () => {
    (tauri.gitDiffFile as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'text', hunks: [] } satisfies DiffResult);
    const onClose = vi.fn();
    render(<DiffDialog projectId={1} repoLabel="." files={FILES} initialFilePath="a.txt" onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('re-fetches when a sidebar file is clicked', async () => {
    (tauri.gitDiffFile as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'text', hunks: [] } satisfies DiffResult);
    render(<DiffDialog projectId={1} repoLabel="frontend" files={FILES} initialFilePath="a.txt" onClose={() => {}} />);
    await waitFor(() => expect(tauri.gitDiffFile).toHaveBeenCalledWith(1, 'frontend', 'a.txt'));
    fireEvent.click(screen.getByText('b.txt'));
    await waitFor(() => expect(tauri.gitDiffFile).toHaveBeenCalledWith(1, 'frontend', 'b.txt'));
  });

  it('navigates files via ArrowDown', async () => {
    (tauri.gitDiffFile as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'text', hunks: [] } satisfies DiffResult);
    render(<DiffDialog projectId={1} repoLabel="." files={FILES} initialFilePath="a.txt" onClose={() => {}} />);
    await waitFor(() => expect(tauri.gitDiffFile).toHaveBeenCalledWith(1, '.', 'a.txt'));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    await waitFor(() => expect(tauri.gitDiffFile).toHaveBeenCalledWith(1, '.', 'b.txt'));
  });
});
