import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../../store/tabsSlice';

type MockState = Record<string, unknown>;
let mockState: MockState;

const actions = vi.hoisted(() => ({
  ensureNoteDraft: vi.fn(),
  deleteNoteById: vi.fn(),
  editNoteDraft: vi.fn(),
  retryNoteDraft: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../store', () => ({
  useStore: (selector: (state: MockState) => unknown) => selector(mockState),
}));

vi.mock('sonner', () => ({ toast: { error: actions.toastError } }));

import { NoteTabView } from './NoteTabView';

const tab: Extract<Tab, { kind: 'note' }> = { kind: 'note', id: 'note:5', projectId: 4, noteId: 5, title: 'Klient' };

function draft(overrides: Record<string, unknown> = {}) {
  return { key: 'k1', noteId: 5, projectId: 4, content: 'Klient', savedContent: 'Klient', status: 'idle', ...overrides };
}

describe('NoteTabView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actions.ensureNoteDraft.mockResolvedValue('k1');
    actions.deleteNoteById.mockResolvedValue(true);
    mockState = { noteDrafts: { k1: draft() }, ...actions };
  });

  it('shows the scope and deletes after confirmation', async () => {
    mockState = { noteDrafts: { k1: draft({ projectId: null }) }, ...actions };
    render(<NoteTabView tab={tab} visible focused />);
    expect(await screen.findByText('Notatka globalna')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Usuń notatkę' }));
    expect(actions.deleteNoteById).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Usuń' }));
    await waitFor(() => expect(actions.deleteNoteById).toHaveBeenCalledWith(5));
  });

  it('labels a project note', async () => {
    render(<NoteTabView tab={tab} visible focused />);
    expect(await screen.findByText('Notatka projektowa')).toBeInTheDocument();
  });

  it('shows a loading state while the draft is prepared', () => {
    actions.ensureNoteDraft.mockReturnValue(new Promise(() => {}));
    render(<NoteTabView tab={tab} visible focused />);
    expect(screen.getByText('Wczytywanie notatki…')).toBeInTheDocument();
  });

  it('reports a note that cannot be loaded', async () => {
    actions.ensureNoteDraft.mockResolvedValue(null);
    render(<NoteTabView tab={tab} visible focused />);
    expect(await screen.findByText('Nie udało się wczytać notatki.')).toBeInTheDocument();
  });

  it('warns when deleting fails', async () => {
    actions.deleteNoteById.mockResolvedValueOnce(false);
    render(<NoteTabView tab={tab} visible focused />);
    fireEvent.click(await screen.findByRole('button', { name: 'Usuń notatkę' }));
    fireEvent.click(screen.getByRole('button', { name: 'Usuń' }));
    await waitFor(() => expect(actions.toastError).toHaveBeenCalledWith('Nie udało się usunąć notatki'));
  });

  it('takes the keyboard only while visible and focused', async () => {
    const { rerender } = render(<NoteTabView tab={tab} visible={false} focused />);
    const textarea = await screen.findByRole('textbox', { name: 'Treść notatki' });
    expect(textarea).not.toHaveFocus();
    rerender(<NoteTabView tab={tab} visible focused={false} />);
    expect(textarea).not.toHaveFocus();
    rerender(<NoteTabView tab={tab} visible focused />);
    expect(textarea).toHaveFocus();
  });
});
