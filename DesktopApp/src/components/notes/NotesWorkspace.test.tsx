import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
