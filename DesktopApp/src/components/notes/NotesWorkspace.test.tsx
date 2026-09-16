import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '../../types';

vi.mock('../../lib/tauri', () => ({
  tauri: {
    listNotes: vi.fn(),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from 'sonner';
import { tauri } from '../../lib/tauri';
import { NotesWorkspace } from './NotesWorkspace';

const projectNote: Note = {
  id: 5, projectId: 2, title: 'Plan', content: 'Treść', createdAt: 10, updatedAt: 20,
};
const globalNote: Note = { ...projectNote, id: 6, projectId: null, title: 'Globalna' };
const newerNote: Note = { ...projectNote, id: 7, title: 'Nowsza', updatedAt: 30 };
const savedNote: Note = { ...projectNote, id: 8, title: 'Nowa', content: 'Tekst', updatedAt: 40 };
const onDirtyChange = vi.fn();

const confirmDeletion = () => {
  const dialog = screen.getByRole('heading', { name: 'Usuń notatkę' }).parentElement!;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Usuń' }));
};

describe('NotesWorkspace', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('loads project notes first and opens a selected note', async () => {
    vi.mocked(tauri.listNotes).mockResolvedValueOnce([projectNote]);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    expect(screen.getByText('Otwórz notatkę z listy lub utwórz nową.')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Otwórz Plan' }));
    expect(tauri.listNotes).toHaveBeenCalledWith(2);
    expect(screen.getByLabelText('Tytuł')).toHaveValue('Plan');
    expect(screen.getByLabelText('Treść')).toHaveValue('Treść');
    expect(screen.getByRole('button', { name: 'Usuń' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Usuń Plan' })).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('switches to global notes and clears the selected draft', async () => {
    vi.mocked(tauri.listNotes).mockResolvedValueOnce([projectNote]).mockResolvedValueOnce([globalNote]);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Otwórz Plan' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Globalne' }));
    expect(screen.queryByLabelText('Tytuł')).not.toBeInTheDocument();
    await screen.findByText('Globalna');
    expect(tauri.listNotes).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('tab', { name: 'Globalne' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Plan')).not.toBeInTheDocument();
  });

  it('persists a new draft only after save and marks it clean', async () => {
    vi.mocked(tauri.listNotes).mockResolvedValue([]);
    vi.mocked(tauri.createNote).mockResolvedValue(savedNote);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    await screen.findByText('Brak notatek projektowych');
    fireEvent.click(screen.getByRole('button', { name: 'Nowa notatka' }));
    expect(tauri.createNote).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Usuń' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: 'Nowa' } });
    fireEvent.change(screen.getByLabelText('Treść'), { target: { value: 'Tekst' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    await screen.findByRole('button', { name: 'Otwórz Nowa' });
    expect(tauri.createNote).toHaveBeenCalledWith(2, 'Nowa', 'Tekst');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith('Notatka została zapisana');
  });

  it('updates an existing note and moves it to the top', async () => {
    vi.mocked(tauri.listNotes).mockResolvedValue([newerNote, projectNote]);
    vi.mocked(tauri.updateNote).mockResolvedValue({ ...projectNote, title: 'Zmieniona', updatedAt: 99 });
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Otwórz Plan' }));
    fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: 'Zmieniona' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    await waitFor(() => expect(screen.getAllByTestId('note-row')[0]).toHaveTextContent('Zmieniona'));
    expect(tauri.updateNote).toHaveBeenCalledWith(5, 'Zmieniona', 'Treść');
    expect(screen.getAllByTestId('note-row')).toHaveLength(2);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('blocks saving a blank title', async () => {
    vi.mocked(tauri.listNotes).mockResolvedValue([]);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    await screen.findByText('Brak notatek projektowych');
    fireEvent.click(screen.getByRole('button', { name: 'Nowa notatka' }));
    fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    expect(tauri.createNote).not.toHaveBeenCalled();
    expect(tauri.updateNote).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Zapisz' })).toBeDisabled();
  });

  it('trims the title but preserves global note content exactly', async () => {
    const content = '  Tekst\n\n  ';
    vi.mocked(tauri.listNotes).mockResolvedValue([]);
    vi.mocked(tauri.createNote).mockResolvedValue({ ...savedNote, projectId: null, content });
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    await screen.findByText('Brak notatek projektowych');
    fireEvent.click(screen.getByRole('tab', { name: 'Globalne' }));
    await screen.findByText('Brak notatek globalnych');
    fireEvent.click(screen.getByRole('button', { name: 'Nowa notatka' }));
    fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: '  Nowa  ' } });
    fireEvent.change(screen.getByLabelText('Treść'), { target: { value: content } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    await screen.findByRole('button', { name: 'Otwórz Nowa' });
    expect(tauri.createNote).toHaveBeenCalledWith(null, 'Nowa', content);
    expect(screen.getByLabelText('Treść')).toHaveValue(content);
  });

  it('offers retry after a list failure and recovers', async () => {
    vi.mocked(tauri.listNotes).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([projectNote]);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Spróbuj ponownie' }));
    await screen.findByRole('button', { name: 'Otwórz Plan' });
    expect(tauri.listNotes).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Spróbuj ponownie' })).not.toBeInTheDocument();
  });

  it.each([false, true])('preserves a saved note when an older retry response arrives (includes saved id: %s)', async (includesSavedId) => {
    let resolveList!: (notes: Note[]) => void;
    let resolveSave!: (note: Note) => void;
    vi.mocked(tauri.listNotes)
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveList = resolve; }));
    vi.mocked(tauri.createNote).mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; }));
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    await screen.findByRole('button', { name: 'Spróbuj ponownie' });
    fireEvent.click(screen.getByRole('button', { name: 'Nowa notatka' }));
    fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: 'Nowa' } });
    fireEvent.change(screen.getByLabelText('Treść'), { target: { value: 'Tekst' } });
    fireEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    await act(async () => { resolveSave(savedNote); });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await act(async () => {
      resolveList(includesSavedId
        ? [projectNote, { ...savedNote, title: 'Starszy tytuł', updatedAt: 25 }]
        : [projectNote]);
    });
    const rows = screen.getAllByTestId('note-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Nowa');
    expect(rows[1]).toHaveTextContent('Plan');
    expect(screen.getByRole('button', { name: 'Otwórz Nowa' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Tytuł')).toHaveValue('Nowa');
    expect(screen.getByLabelText('Treść')).toHaveValue('Tekst');
    expect(screen.queryByText('Starszy tytuł')).not.toBeInTheDocument();
  });

  it.each(['create', 'update'])('preserves both inputs and reports a rejected %s', async (operation) => {
    vi.mocked(tauri.listNotes).mockResolvedValue(operation === 'create' ? [] : [projectNote]);
    vi.mocked(tauri.createNote).mockRejectedValue(new Error('offline'));
    vi.mocked(tauri.updateNote).mockRejectedValue(new Error('offline'));
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    if (operation === 'create') {
      await screen.findByText('Brak notatek projektowych');
      fireEvent.click(screen.getByRole('button', { name: 'Nowa notatka' }));
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Otwórz Plan' }));
    }
    fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: '  Mój tytuł  ' } });
    fireEvent.change(screen.getByLabelText('Treść'), { target: { value: 'Niezapisana treść\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByLabelText('Tytuł')).toHaveValue('  Mój tytuł  ');
    expect(screen.getByLabelText('Treść')).toHaveValue('Niezapisana treść\n');
    expect(screen.getByRole('button', { name: 'Zapisz' })).toBeEnabled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('clears old notes during scope loading and ignores a stale response', async () => {
    let resolveProject!: (notes: Note[]) => void;
    let resolveGlobal!: (notes: Note[]) => void;
    vi.mocked(tauri.listNotes)
      .mockResolvedValueOnce([projectNote])
      .mockImplementationOnce(() => new Promise(resolve => { resolveGlobal = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveProject = resolve; }));
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    await screen.findByText('Plan');
    fireEvent.click(screen.getByRole('tab', { name: 'Globalne' }));
    expect(screen.queryByText('Plan')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Projektowe' }));
    await act(async () => { resolveProject([projectNote]); });
    await act(async () => { resolveGlobal([globalNote]); });
    expect(screen.getByRole('button', { name: 'Otwórz Plan' })).toBeInTheDocument();
    expect(screen.queryByText('Globalna')).not.toBeInTheDocument();
  });

  it.each(['note', 'scope', 'new'])('guards dirty navigation to %s and supports cancelling or discarding', async (target) => {
    vi.mocked(tauri.listNotes).mockResolvedValueOnce([newerNote, projectNote]).mockResolvedValueOnce([globalNote]);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Otwórz Plan' }));
    fireEvent.change(screen.getByLabelText('Treść'), { target: { value: 'Niezapisane' } });
    const navigate = () => fireEvent.click(target === 'scope'
      ? screen.getByRole('tab', { name: 'Globalne' })
      : screen.getByRole('button', { name: target === 'note' ? 'Otwórz Nowsza' : 'Nowa notatka' }));

    navigate();
    expect(screen.getByText('Odrzucić niezapisane zmiany?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Anuluj' }));
    expect(screen.getByLabelText('Tytuł')).toHaveValue('Plan');
    expect(screen.getByLabelText('Treść')).toHaveValue('Niezapisane');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(tauri.listNotes).toHaveBeenCalledTimes(1);

    navigate();
    fireEvent.click(screen.getByRole('button', { name: 'Odrzuć' }));
    expect(screen.queryByText('Odrzucić niezapisane zmiany?')).not.toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    if (target === 'scope') {
      await screen.findByRole('button', { name: 'Otwórz Globalna' });
      expect(tauri.listNotes).toHaveBeenLastCalledWith(null);
      expect(screen.queryByLabelText('Tytuł')).not.toBeInTheDocument();
    } else {
      expect(screen.getByLabelText('Tytuł')).toHaveValue(target === 'note' ? 'Nowsza' : '');
      expect(screen.getByLabelText('Treść')).toHaveValue(target === 'note' ? 'Treść' : '');
    }
  });

  it('preserves dirty edits when reopening the selected note or scope', async () => {
    vi.mocked(tauri.listNotes).mockResolvedValue([projectNote]);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Otwórz Plan' }));
    fireEvent.change(screen.getByLabelText('Treść'), { target: { value: 'Niezapisane' } });
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz Plan' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Projektowe' }));
    expect(screen.getByLabelText('Treść')).toHaveValue('Niezapisane');
    expect(screen.queryByText('Odrzucić niezapisane zmiany?')).not.toBeInTheDocument();
    expect(tauri.listNotes).toHaveBeenCalledTimes(1);
  });

  it('guards leaving an unsaved new draft', async () => {
    vi.mocked(tauri.listNotes).mockResolvedValue([projectNote]);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    await screen.findByRole('button', { name: 'Otwórz Plan' });
    fireEvent.click(screen.getByRole('button', { name: 'Nowa notatka' }));
    fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: 'Szkic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz Plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Anuluj' }));
    expect(screen.getByLabelText('Tytuł')).toHaveValue('Szkic');
    expect(tauri.createNote).not.toHaveBeenCalled();
  });

  it.each(['row', 'editor'])('confirms deletion from the %s and keeps the note on cancel', async (source) => {
    vi.mocked(tauri.listNotes).mockResolvedValue([projectNote]);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Otwórz Plan' }));
    fireEvent.click(screen.getByRole('button', { name: source === 'row' ? 'Usuń Plan' : 'Usuń' }));
    expect(screen.getByText('Usunąć notatkę „Plan”? Tej operacji nie można cofnąć.')).toBeInTheDocument();
    expect(tauri.deleteNote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Anuluj' }));
    expect(tauri.deleteNote).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Otwórz Plan' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Treść')).toHaveValue('Treść');
    expect(screen.queryByRole('heading', { name: 'Usuń notatkę' })).not.toBeInTheDocument();
  });

  it('removes the selected note only after success and selects the newest remaining note', async () => {
    let resolveDelete!: () => void;
    vi.mocked(tauri.listNotes).mockResolvedValue([newerNote, projectNote, { ...globalNote, projectId: 2 }]);
    vi.mocked(tauri.deleteNote).mockImplementationOnce(() => new Promise(resolve => { resolveDelete = resolve; }));
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Otwórz Plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Usuń Plan' }));
    confirmDeletion();
    expect(tauri.deleteNote).toHaveBeenCalledWith(5);
    expect(screen.getByRole('button', { name: 'Otwórz Plan' })).toBeInTheDocument();
    expect(screen.getByLabelText('Tytuł')).toHaveValue('Plan');
    expect(screen.getByRole('button', { name: 'Nowa notatka' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Globalne' })).toBeDisabled();
    expect(screen.getByLabelText('Treść')).toBeDisabled();
    confirmDeletion();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tauri.deleteNote).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Usuń notatkę' })).toBeInTheDocument();

    await act(async () => { resolveDelete(); });
    expect(screen.queryByRole('button', { name: 'Otwórz Plan' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Otwórz Nowsza' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Tytuł')).toHaveValue('Nowsza');
    expect(screen.getAllByTestId('note-row')).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: 'Usuń notatkę' })).not.toBeInTheDocument();
  });

  it('clears the editor after deleting its last note', async () => {
    vi.mocked(tauri.listNotes).mockResolvedValue([projectNote]);
    vi.mocked(tauri.deleteNote).mockResolvedValue(undefined);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Otwórz Plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Usuń' }));
    confirmDeletion();
    await screen.findByText('Brak notatek projektowych');
    expect(screen.queryByLabelText('Tytuł')).not.toBeInTheDocument();
    expect(screen.getByText('Otwórz notatkę z listy lub utwórz nową.')).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it.each(['row', 'editor'])('guards dirty deletion from the %s and preserves edits when either dialog is cancelled', async (source) => {
    vi.mocked(tauri.listNotes).mockResolvedValue([projectNote]);
    vi.mocked(tauri.deleteNote).mockResolvedValue(undefined);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Otwórz Plan' }));
    fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: 'Niezapisany tytuł' } });
    fireEvent.change(screen.getByLabelText('Treść'), { target: { value: 'Niezapisane' } });
    const requestDelete = () => fireEvent.click(screen.getByRole('button', { name: source === 'row' ? 'Usuń Plan' : 'Usuń' }));

    requestDelete();
    expect(screen.getByText('Odrzucić niezapisane zmiany?')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Usuń notatkę' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Anuluj' }));
    expect(screen.getByLabelText('Treść')).toHaveValue('Niezapisane');

    requestDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Odrzuć' }));
    expect(screen.queryByText('Odrzucić niezapisane zmiany?')).not.toBeInTheDocument();
    expect(screen.getByText('Usunąć notatkę „Plan”? Tej operacji nie można cofnąć.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Anuluj' }));
    expect(screen.getByLabelText('Tytuł')).toHaveValue('Niezapisany tytuł');
    expect(screen.getByLabelText('Treść')).toHaveValue('Niezapisane');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(tauri.deleteNote).not.toHaveBeenCalled();

    requestDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Odrzuć' }));
    confirmDeletion();
    await screen.findByText('Brak notatek projektowych');
    expect(tauri.deleteNote).toHaveBeenCalledWith(5);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('preserves the dirty draft and confirmation after a rejected deletion and allows retry', async () => {
    vi.mocked(tauri.listNotes).mockResolvedValue([projectNote]);
    vi.mocked(tauri.deleteNote).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Otwórz Plan' }));
    fireEvent.change(screen.getByLabelText('Treść'), { target: { value: 'Niezapisane' } });
    fireEvent.click(screen.getByRole('button', { name: 'Usuń Plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Odrzuć' }));
    confirmDeletion();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nie udało się usunąć notatki'));
    expect(screen.getByRole('button', { name: 'Otwórz Plan' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Treść')).toHaveValue('Niezapisane');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('Usunąć notatkę „Plan”? Tej operacji nie można cofnąć.')).toBeInTheDocument();
    confirmDeletion();
    await screen.findByText('Brak notatek projektowych');
    expect(tauri.deleteNote).toHaveBeenCalledTimes(2);
  });

  it('deletes an unselected note without discarding the current dirty draft', async () => {
    vi.mocked(tauri.listNotes).mockResolvedValue([newerNote, projectNote]);
    vi.mocked(tauri.deleteNote).mockResolvedValue(undefined);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Otwórz Plan' }));
    fireEvent.change(screen.getByLabelText('Treść'), { target: { value: 'Niezapisane' } });
    fireEvent.click(screen.getByRole('button', { name: 'Usuń Nowsza' }));
    expect(screen.queryByText('Odrzucić niezapisane zmiany?')).not.toBeInTheDocument();
    expect(screen.getByText('Usunąć notatkę „Nowsza”? Tej operacji nie można cofnąć.')).toBeInTheDocument();
    confirmDeletion();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Otwórz Nowsza' })).not.toBeInTheDocument());
    expect(tauri.deleteNote).toHaveBeenCalledWith(7);
    expect(screen.getByLabelText('Treść')).toHaveValue('Niezapisane');
    expect(screen.getByRole('button', { name: 'Otwórz Plan' })).toHaveAttribute('aria-pressed', 'true');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it.each(['before', 'after'])('preserves loaded notes when a retry resolves %s deletion', async (listTiming) => {
    let resolveList!: (notes: Note[]) => void;
    let resolveDelete!: () => void;
    vi.mocked(tauri.listNotes)
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveList = resolve; }));
    vi.mocked(tauri.createNote).mockResolvedValue(savedNote);
    vi.mocked(tauri.deleteNote).mockImplementationOnce(() => new Promise(resolve => { resolveDelete = resolve; }));
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    await screen.findByRole('button', { name: 'Spróbuj ponownie' });
    fireEvent.click(screen.getByRole('button', { name: 'Nowa notatka' }));
    fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: 'Nowa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Usuń' }));
    confirmDeletion();

    if (listTiming === 'before') {
      await act(async () => { resolveList([savedNote, projectNote]); });
    }
    await act(async () => { resolveDelete(); });
    if (listTiming === 'after') {
      await act(async () => { resolveList([savedNote, projectNote]); });
    }
    expect(screen.getByRole('button', { name: 'Otwórz Plan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Otwórz Nowa' })).not.toBeInTheDocument();
    if (listTiming === 'before') {
      expect(screen.getByLabelText('Tytuł')).toHaveValue('Plan');
    }
  });

  it.each([false, true])('deletes a saved draft from the editor after both list attempts fail (dirty: %s)', async (dirty) => {
    vi.mocked(tauri.listNotes)
      .mockRejectedValueOnce(new Error('initial load failed'))
      .mockRejectedValueOnce(new Error('retry failed'));
    vi.mocked(tauri.createNote).mockResolvedValue(savedNote);
    vi.mocked(tauri.deleteNote).mockResolvedValue(undefined);
    render(<NotesWorkspace projectId={2} onDirtyChange={onDirtyChange} />);
    await screen.findByRole('button', { name: 'Spróbuj ponownie' });
    fireEvent.click(screen.getByRole('button', { name: 'Nowa notatka' }));
    fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: 'Nowa' } });
    fireEvent.change(screen.getByLabelText('Treść'), { target: { value: 'Tekst' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    await screen.findByRole('button', { name: 'Usuń' });
    expect(tauri.createNote).toHaveBeenCalledWith(2, 'Nowa', 'Tekst');
    fireEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    await screen.findByRole('button', { name: 'Spróbuj ponownie' });
    expect(tauri.listNotes).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Otwórz Nowa' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Tytuł')).toHaveValue('Nowa');

    if (dirty) {
      fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: 'Niezapisany tytuł' } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Usuń' }));
    if (dirty) {
      fireEvent.click(screen.getByRole('button', { name: 'Odrzuć' }));
    }
    expect(screen.getByText('Usunąć notatkę „Nowa”? Tej operacji nie można cofnąć.')).toBeInTheDocument();
    expect(tauri.deleteNote).not.toHaveBeenCalled();
    confirmDeletion();
    await screen.findByText('Otwórz notatkę z listy lub utwórz nową.');
    expect(tauri.deleteNote).toHaveBeenCalledExactlyOnceWith(8);
    expect(screen.queryByLabelText('Tytuł')).not.toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});
