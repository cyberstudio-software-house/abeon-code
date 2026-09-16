import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';

const { onCloseRequested, destroy, unlisten } = vi.hoisted(() => ({
  onCloseRequested: vi.fn(),
  destroy: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ onCloseRequested, destroy, label: 'notes-project-2' }),
}));

vi.mock('./NotesWorkspace', () => ({
  NotesWorkspace: ({ projectId, onDirtyChange }: { projectId: number; onDirtyChange: (dirty: boolean) => void }) => (
    <section aria-label={`Notes for project ${projectId}`}>
      <button onClick={() => onDirtyChange(true)}>Mark dirty</button>
      <button onClick={() => onDirtyChange(false)}>Mark clean</button>
    </section>
  ),
}));

import { tauri } from '../../lib/tauri';
import { NotesShell } from './NotesShell';

const project: Project = {
  id: 2, name: 'Demo', path: '/demo', claudeDir: '/demo/.claude',
  color: null, sortOrder: 0, createdAt: 0,
};

function requestClose() {
  const event = { preventDefault: vi.fn() };
  act(() => onCloseRequested.mock.calls[0][0](event));
  return event;
}

describe('NotesShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onCloseRequested.mockResolvedValue(unlisten);
    destroy.mockResolvedValue(undefined);
    vi.spyOn(tauri, 'listProjects').mockResolvedValue([project]);
    vi.spyOn(tauri, 'setWindowTitle').mockResolvedValue(undefined);
  });

  it('loads the project and sets the native and visible window titles', async () => {
    render(<NotesShell projectId={2} />);

    expect(await screen.findByText('Notatki — Demo')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Notes for project 2' })).toBeInTheDocument();
    expect(tauri.setWindowTitle).toHaveBeenCalledWith('Notatki — Demo');
  });

  it('shows loading while the project is unresolved', () => {
    vi.mocked(tauri.listProjects).mockReturnValue(new Promise(() => {}));
    render(<NotesShell projectId={2} />);

    expect(screen.getByRole('status')).toHaveTextContent('Wczytywanie projektu…');
    expect(screen.queryByRole('button', { name: 'Mark dirty' })).not.toBeInTheDocument();
  });

  it('allows a clean window to close normally', async () => {
    render(<NotesShell projectId={2} />);
    await screen.findByText('Notatki — Demo');

    expect(requestClose().preventDefault).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('guards and destroys a dirty window after confirmation', async () => {
    render(<NotesShell projectId={2} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark dirty' }));

    expect(requestClose().preventDefault).toHaveBeenCalledOnce();
    expect(screen.getByText('Odrzucić niezapisane zmiany?')).toBeInTheDocument();
    expect(screen.getByText('Zamknięcie okna spowoduje utratę niezapisanych zmian.')).toBeInTheDocument();
    expect(destroy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Odrzuć i zamknij' }));
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('keeps the dirty workspace open after cancelling close', async () => {
    render(<NotesShell projectId={2} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark dirty' }));
    requestClose();
    fireEvent.click(screen.getByRole('button', { name: 'Anuluj' }));

    expect(screen.queryByText('Odrzucić niezapisane zmiany?')).not.toBeInTheDocument();
    expect(destroy).not.toHaveBeenCalled();
    expect(requestClose().preventDefault).toHaveBeenCalledOnce();
  });

  it('uses the latest dirty state without registering another close listener', async () => {
    render(<NotesShell projectId={2} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark dirty' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark clean' }));

    expect(requestClose().preventDefault).not.toHaveBeenCalled();
    expect(onCloseRequested).toHaveBeenCalledOnce();
  });

  it('renders a safe error for an unknown project', async () => {
    vi.mocked(tauri.listProjects).mockResolvedValue([]);
    render(<NotesShell projectId={404} />);

    expect(await screen.findByText('Nie znaleziono projektu dla tego okna notatek.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark dirty' })).not.toBeInTheDocument();
  });

  it('retries loading the project after a list failure', async () => {
    vi.mocked(tauri.listProjects).mockRejectedValueOnce(new Error('Unavailable'));
    render(<NotesShell projectId={2} />);

    expect(await screen.findByText('Nie udało się wczytać projektu dla okna notatek.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark dirty' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    expect(await screen.findByText('Notatki — Demo')).toBeInTheDocument();
    expect(tauri.listProjects).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes the native close listener on unmount', async () => {
    const { unmount } = render(<NotesShell projectId={2} />);
    await screen.findByText('Notatki — Demo');
    unmount();

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('unsubscribes when the native listener finishes registering after unmount', async () => {
    let finishRegistration!: (callback: () => void) => void;
    onCloseRequested.mockReturnValue(new Promise<() => void>(resolve => { finishRegistration = resolve; }));
    const { unmount } = render(<NotesShell projectId={2} />);
    unmount();
    finishRegistration(unlisten);

    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });
});
