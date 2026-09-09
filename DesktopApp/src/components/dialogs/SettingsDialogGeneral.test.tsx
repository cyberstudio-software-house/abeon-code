import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { SettingsDialog } from './SettingsDialog';

describe('SettingsDialog tab layout mode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauri, 'listAvailableShells').mockResolvedValue([]);
    vi.spyOn(tauri, 'detectDefaultShell').mockResolvedValue(null);
    vi.spyOn(tauri, 'listAvailableEditors').mockResolvedValue([]);
    vi.spyOn(tauri, 'attentionHookStatus').mockResolvedValue(false);
    useStore.setState({ tabLayoutMode: 'classic' });
  });

  it('switches between the classic and the stacked tab bar', () => {
    render(<SettingsDialog />);

    fireEvent.click(screen.getByText('Dwuwierszowy'));
    expect(useStore.getState().tabLayoutMode).toBe('stacked');

    fireEvent.click(screen.getByText('Klasyczny'));
    expect(useStore.getState().tabLayoutMode).toBe('classic');
  });
});
