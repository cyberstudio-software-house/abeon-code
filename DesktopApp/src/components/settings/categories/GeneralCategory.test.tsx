import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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
