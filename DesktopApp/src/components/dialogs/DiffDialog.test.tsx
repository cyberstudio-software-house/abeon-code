import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DiffDialog } from './DiffDialog';
import type { GitFile, DiffResult } from '../../types';

const FILES: GitFile[] = [
  { path: 'a.txt', status: 'M', staged: false, additions: 1, deletions: 1 },
  { path: 'b.txt', status: 'A', staged: true, additions: 5, deletions: 0 },
];

const EMPTY: DiffResult = { kind: 'text', hunks: [] };

function renderDialog(overrides: Partial<React.ComponentProps<typeof DiffDialog>> = {}) {
  const props: React.ComponentProps<typeof DiffDialog> = {
    repoLabel: '.',
    files: FILES,
    initialFilePath: 'a.txt',
    loadDiff: vi.fn().mockResolvedValue(EMPTY),
    onClose: () => {},
    ...overrides,
  };
  render(<DiffDialog {...props} />);
  return props;
}

describe('DiffDialog', () => {
  it('shows loading state initially', () => {
    renderDialog({ loadDiff: vi.fn().mockReturnValue(new Promise(() => {})) });
    expect(screen.getByText(/Wczytywanie diffa/i)).toBeInTheDocument();
  });

  it('renders binary message', async () => {
    renderDialog({ loadDiff: vi.fn().mockResolvedValue({ kind: 'binary' } satisfies DiffResult) });
    await waitFor(() => expect(screen.getByText(/Plik binarny/i)).toBeInTheDocument());
  });

  it('renders too-large message', async () => {
    renderDialog({ loadDiff: vi.fn().mockResolvedValue({ kind: 'tooLarge', size: 3_000_000 } satisfies DiffResult) });
    await waitFor(() => expect(screen.getByText(/Plik za du/i)).toBeInTheDocument());
  });

  it('renders empty-changes message when hunks empty', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText(/Brak zmian tekstowych/i)).toBeInTheDocument());
  });

  it('renders error message when loader rejects', async () => {
    renderDialog({ loadDiff: vi.fn().mockRejectedValue('boom') });
    await waitFor(() => expect(screen.getByText(/Błąd: boom/i)).toBeInTheDocument());
  });

  it('calls onClose on Escape', async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('loads the diff via loadDiff for the initial file', async () => {
    const { loadDiff } = renderDialog({ repoLabel: 'frontend' });
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith('a.txt'));
  });

  it('re-fetches when a sidebar file is clicked', async () => {
    const { loadDiff } = renderDialog();
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith('a.txt'));
    fireEvent.click(screen.getByText('b.txt'));
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith('b.txt'));
  });

  it('navigates files via ArrowDown', async () => {
    const { loadDiff } = renderDialog();
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith('a.txt'));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith('b.txt'));
  });

  it('renders the summary slot above the file list', () => {
    renderDialog({ summary: <div>commit summary here</div> });
    expect(screen.getByText('commit summary here')).toBeInTheDocument();
  });
});
