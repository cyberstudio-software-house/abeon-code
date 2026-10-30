import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ onFocusChanged: async () => () => {} }),
}));
vi.mock('./ProjectItem', () => ({ ProjectItem: () => <li /> }));
vi.mock('./SidebarFooter', () => ({ SidebarFooter: () => <div /> }));
vi.mock('./SortMenu', () => ({ SortMenu: () => <div /> }));
vi.mock('./ActiveSessionsPanel', () => ({ ActiveSessionsPanel: () => <div /> }));
vi.mock('../supervisor/SupervisorEntry', () => ({ SupervisorEntry: () => <div /> }));
vi.mock('../dialogs/AddProjectDialog', () => ({ AddProjectDialog: () => <div /> }));

import { useStore } from '../../store';
import { Sidebar } from './Sidebar';

describe('Sidebar search shortcut', () => {
  beforeEach(() => {
    useStore.setState({
      loadProjects: vi.fn(),
      loadActivity: vi.fn(),
      refreshActiveSessions: vi.fn(),
      settingsOpen: false,
    } as never);
  });

  it('does not focus the search while settings are open', () => {
    render(<Sidebar />);
    const input = screen.getByPlaceholderText('Szukaj projektu lub sesji…');
    act(() => { useStore.getState().openSettings(); });

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

    expect(document.activeElement).not.toBe(input);

    act(() => { useStore.getState().closeSettings(); });
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

    expect(document.activeElement).toBe(input);
  });
});

describe('Sidebar search field', () => {
  beforeEach(() => {
    useStore.setState({
      loadProjects: vi.fn(),
      loadActivity: vi.fn(),
      refreshActiveSessions: vi.fn(),
      settingsOpen: false,
    } as never);
  });

  it('keeps the search input accessible by its name, not by the shortcut hint', () => {
    render(<Sidebar />);
    const input = screen.getByRole('textbox', { name: 'Szukaj projektu lub sesji' });
    expect(input).toBe(screen.getByPlaceholderText('Szukaj projektu lub sesji…'));
  });
});
