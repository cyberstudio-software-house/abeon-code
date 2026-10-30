import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { useStore } from '../../../store';
import { tauri } from '../../../lib/tauri';
import { GeneralCategory } from './GeneralCategory';

describe('GeneralCategory session restore mode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauri, 'listAvailableShells').mockResolvedValue([]);
    vi.spyOn(tauri, 'detectDefaultShell').mockResolvedValue(null);
    vi.spyOn(tauri, 'listAvailableEditors').mockResolvedValue([]);
    vi.spyOn(tauri, 'attentionHookStatus').mockResolvedValue(false);
    useStore.setState({ sessionRestoreMode: 'ask' });
  });

  it('switches between asking, resuming automatically and never resuming', () => {
    render(<GeneralCategory />);

    fireEvent.click(screen.getByText('Nie wznawiaj'));
    expect(useStore.getState().sessionRestoreMode).toBe('never');

    fireEvent.click(screen.getByText('Wznawiaj automatycznie'));
    expect(useStore.getState().sessionRestoreMode).toBe('always');

    fireEvent.click(screen.getByText('Pytaj'));
    expect(useStore.getState().sessionRestoreMode).toBe('ask');
  });
});

describe('GeneralCategory page', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauri, 'listAvailableShells').mockResolvedValue([]);
    vi.spyOn(tauri, 'detectDefaultShell').mockResolvedValue(null);
    vi.spyOn(tauri, 'listAvailableEditors').mockResolvedValue([]);
    useStore.setState({ sessionRestoreMode: 'ask', historyViewMode: 'communication' });
  });

  it('renders the Ogólne page as in the mockup', () => {
    render(<GeneralCategory />);
    expect(screen.getByRole('heading', { level: 1, name: 'Ogólne' })).toBeInTheDocument();
    expect(screen.getByText('Profil, projekty, sesje i narzędzia systemowe.')).toBeInTheDocument();
    for (const label of ['Profil i projekty', 'Sesje', 'Narzędzia systemowe']) {
      expect(screen.getByRole('heading', { level: 2, name: label })).toBeInTheDocument();
    }
    expect(screen.getByText('Zmiany zapisują się automatycznie')).toBeInTheDocument();

    const restore = screen.getByRole('group', { name: 'Sesje po uruchomieniu' });
    expect(within(restore).getByRole('button', { name: 'Pytaj' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(restore).getByRole('button', { name: 'Nie wznawiaj' })).toHaveAttribute('aria-pressed', 'false');

    const history = screen.getByRole('group', { name: 'Domyślny widok historii' });
    expect(within(history).getByRole('button', { name: 'Komunikacja' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('labels the text fields and selects', () => {
    render(<GeneralCategory />);
    expect(screen.getByLabelText('Nazwa wyświetlana')).toBeInTheDocument();
    expect(screen.getByLabelText('Ścieżka bazowa projektów')).toBeInTheDocument();
    expect(screen.getByLabelText('Domyślny shell')).toBeInTheDocument();
    expect(screen.getByLabelText('Domyślny edytor')).toBeInTheDocument();
  });
});
