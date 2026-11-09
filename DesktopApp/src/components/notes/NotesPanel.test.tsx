import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '../../types';

type MockState = Record<string, unknown>;
let mockState: MockState;

const actions = vi.hoisted(() => ({
  loadNotes: vi.fn(),
  setNotesScope: vi.fn(),
  startNewNote: vi.fn(),
  openNoteInPanel: vi.fn(),
  closeNotesPanel: vi.fn(),
  backToNotesList: vi.fn(),
  editNoteDraft: vi.fn(),
  retryNoteDraft: vi.fn(),
  discardNoteDraft: vi.fn(),
  deleteNoteById: vi.fn(),
  openNoteInTab: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../store', () => ({
  useStore: (selector: (state: MockState) => unknown) => selector(mockState),
}));

vi.mock('sonner', () => ({ toast: { error: actions.toastError } }));

import { NotesPanel } from './NotesPanel';

const NOW = new Date(2026, 10, 9, 15, 0, 0).getTime();
const NOTE: Note = {
  id: 5,
  projectId: 4,
  content: 'Klient chce CSV…',
  createdAt: new Date(2026, 10, 9, 14, 0, 0).getTime(),
  updatedAt: new Date(2026, 10, 9, 14, 32, 0).getTime(),
};

function draft(overrides: Record<string, unknown> = {}) {
  return {
    key: 'k1',
    noteId: 5,
    projectId: 4,
    content: 'Klient chce CSV…',
    savedContent: 'Klient chce CSV…',
    status: 'idle',
    ...overrides,
  };
}

function baseState(overrides: MockState = {}): MockState {
  return {
    tabs: [{ id: 'tab-4', projectId: 4 }],
    activeTabId: 'tab-4',
    notesScope: 'project',
    notesView: { mode: 'list' },
    notesLists: { 'project:4': { status: 'ready', notes: [NOTE] } },
    noteDrafts: {},
    ...actions,
    ...overrides,
  };
}

function editorState(draftOverrides: Record<string, unknown> = {}, overrides: MockState = {}): MockState {
  return baseState({
    notesView: { mode: 'editor', draftKey: 'k1' },
    noteDrafts: { k1: draft(draftOverrides) },
    ...overrides,
  });
}

describe('NotesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    actions.closeNotesPanel.mockResolvedValue(true);
    actions.backToNotesList.mockResolvedValue(true);
    actions.deleteNoteById.mockResolvedValue(true);
    actions.openNoteInTab.mockResolvedValue(true);
    mockState = baseState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows project notes as tiles and opens one', () => {
    render(<NotesPanel />);
    expect(screen.getByText('Klient chce CSV…')).toBeInTheDocument();
    expect(screen.getByText('dziś, 14:32')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Klient chce CSV…/ }));
    expect(actions.openNoteInPanel).toHaveBeenCalledWith(NOTE);
  });

  it('clamps tile text without a conflicting display utility', () => {
    render(<NotesPanel />);
    const content = screen.getByText('Klient chce CSV…');
    expect(content).toHaveClass('line-clamp-4', 'whitespace-pre-line');
    for (const utility of ['block', 'flex', 'inline', 'inline-block', 'grid']) {
      expect(content).not.toHaveClass(utility);
    }
  });

  it('creates a note in the selected scope', () => {
    const { rerender } = render(<NotesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Nowa notatka' }));
    expect(actions.startNewNote).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByRole('tab', { name: 'Globalne' }));
    expect(actions.setNotesScope).toHaveBeenCalledWith('global');
    mockState = baseState({ notesScope: 'global', notesLists: { global: { status: 'ready', notes: [] } } });
    rerender(<NotesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Nowa notatka' }));
    expect(actions.startNewNote).toHaveBeenLastCalledWith(null);
  });

  it('marks the active scope tab', () => {
    render(<NotesPanel />);
    expect(screen.getByRole('tab', { name: 'Projektowe' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Globalne' })).toHaveAttribute('aria-selected', 'false');
  });

  it('loads the list for the visible scope once', () => {
    mockState = baseState({ notesLists: {} });
    const { rerender } = render(<NotesPanel />);
    rerender(<NotesPanel />);
    expect(actions.loadNotes).toHaveBeenCalledTimes(1);
    expect(actions.loadNotes).toHaveBeenCalledWith(4);
    expect(screen.getByText('Ładowanie notatek…')).toBeInTheDocument();
  });

  it('shows the empty and error states', () => {
    mockState = baseState({ notesLists: { 'project:4': { status: 'ready', notes: [] } } });
    const { rerender } = render(<NotesPanel />);
    expect(screen.getByText('Brak notatek projektowych')).toBeInTheDocument();
    mockState = baseState({ notesScope: 'global', notesLists: { global: { status: 'ready', notes: [] } } });
    rerender(<NotesPanel />);
    expect(screen.getByText('Brak notatek globalnych')).toBeInTheDocument();
    mockState = baseState({ notesLists: { 'project:4': { status: 'error', notes: [] } } });
    rerender(<NotesPanel />);
    expect(screen.getByText('Nie udało się wczytać notatek.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    expect(actions.loadNotes).toHaveBeenCalledWith(4);
  });

  it('does not offer project notes without an active project', () => {
    mockState = baseState({ tabs: [], activeTabId: null, notesLists: {} });
    render(<NotesPanel />);
    expect(screen.getByText('Brak notatek projektowych')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nowa notatka' })).toBeDisabled();
    expect(actions.loadNotes).not.toHaveBeenCalled();
  });

  it('closes the panel and warns when that fails', async () => {
    actions.closeNotesPanel.mockResolvedValueOnce(false);
    render(<NotesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Zamknij panel notatek' }));
    await waitFor(() => expect(actions.toastError).toHaveBeenCalledWith('Nie udało się zapisać notatki'));
  });

  it('edits a note with a focused textarea', () => {
    mockState = editorState();
    render(<NotesPanel />);
    const textarea = screen.getByRole('textbox', { name: 'Treść notatki' }) as HTMLTextAreaElement;
    expect(textarea).toHaveFocus();
    expect(textarea.value).toBe('Klient chce CSV…');
    expect(textarea.selectionStart).toBe('Klient chce CSV…'.length);
    fireEvent.change(textarea, { target: { value: 'Klient chce CSV…X' } });
    expect(actions.editNoteDraft).toHaveBeenCalledWith('k1', 'Klient chce CSV…X');
  });

  it('shows the save status', () => {
    mockState = editorState({ status: 'idle' });
    const { rerender } = render(<NotesPanel />);
    expect(screen.queryByText('Zapisywanie…')).not.toBeInTheDocument();
    mockState = editorState({ status: 'saving' });
    rerender(<NotesPanel />);
    expect(screen.getByText('Zapisywanie…')).toBeInTheDocument();
    mockState = editorState({ status: 'saved' });
    rerender(<NotesPanel />);
    expect(screen.getByText('✓ Zapisano')).toBeInTheDocument();
    mockState = editorState({ status: 'error' });
    rerender(<NotesPanel />);
    expect(screen.getByText('Nie udało się zapisać')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ponów' }));
    expect(actions.retryNoteDraft).toHaveBeenCalledWith('k1');
  });

  it('asks before deleting a saved note', async () => {
    mockState = editorState();
    render(<NotesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Usuń notatkę' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Usunąć tę notatkę? Tej operacji nie można cofnąć.')).toBeInTheDocument();
    expect(actions.deleteNoteById).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Usuń' }));
    await waitFor(() => expect(actions.deleteNoteById).toHaveBeenCalledWith(5));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('warns when deleting fails', async () => {
    actions.deleteNoteById.mockResolvedValueOnce(false);
    mockState = editorState();
    render(<NotesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Usuń notatkę' }));
    fireEvent.click(screen.getByRole('button', { name: 'Usuń' }));
    await waitFor(() => expect(actions.toastError).toHaveBeenCalledWith('Nie udało się usunąć notatki'));
  });

  it('discards an unsaved new note without asking', () => {
    mockState = editorState({ noteId: null, savedContent: '' });
    render(<NotesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Usuń notatkę' }));
    expect(actions.discardNoteDraft).toHaveBeenCalledWith('k1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the note in a tab', async () => {
    mockState = editorState();
    render(<NotesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz w zakładce' }));
    await waitFor(() => expect(actions.openNoteInTab).toHaveBeenCalledWith('k1'));
    expect(actions.toastError).not.toHaveBeenCalled();
  });

  it('warns when the note cannot be opened in a tab', async () => {
    actions.openNoteInTab.mockResolvedValueOnce(false);
    mockState = editorState();
    render(<NotesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz w zakładce' }));
    await waitFor(() => expect(actions.toastError).toHaveBeenCalledWith('Nie udało się zapisać notatki'));
  });

  it('does not offer a tab for a blank new draft', () => {
    mockState = editorState({ noteId: null, content: '', savedContent: '' });
    render(<NotesPanel />);
    expect(screen.getByRole('button', { name: 'Otwórz w zakładce' })).toBeDisabled();
  });

  it('goes back to the list', async () => {
    mockState = editorState();
    render(<NotesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Wróć do listy notatek' }));
    await waitFor(() => expect(actions.backToNotesList).toHaveBeenCalledTimes(1));
    expect(actions.toastError).not.toHaveBeenCalled();
  });

  it('warns when leaving fails', async () => {
    actions.backToNotesList.mockResolvedValueOnce(false);
    mockState = editorState();
    render(<NotesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Wróć do listy notatek' }));
    await waitFor(() => expect(actions.toastError).toHaveBeenCalledWith('Nie udało się zapisać notatki'));
  });
});
