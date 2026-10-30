import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { SidebarFooter } from './SidebarFooter';

describe('SidebarFooter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauri, 'getGitUser').mockResolvedValue({ name: 'Ada Lovelace', initials: 'AL', email: 'ada@example.com' });
    useStore.setState({ settingsOpen: false, displayName: '' });
  });

  it('opens settings without taking focus from the terminal', async () => {
    render(<SidebarFooter />);
    await act(async () => {});
    const button = screen.getByRole('button', { name: 'Ustawienia' });

    expect(fireEvent.mouseDown(button)).toBe(false);
    fireEvent.click(button);

    expect(useStore.getState().settingsOpen).toBe(true);
  });

  it('leaves the settings button out when asked to', async () => {
    render(<SidebarFooter showSettingsButton={false} />);
    await act(async () => {});
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ustawienia' })).toBeNull();
  });
});
