import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = Record<string, unknown>;
let mockState: MockState;

const { openNewTerminalTab, openProjectInEditor, openNotesWindow, toastError } = vi.hoisted(() => ({
  openNewTerminalTab: vi.fn(),
  openProjectInEditor: vi.fn(),
  openNotesWindow: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../store', () => ({
  useStore: (selector: (state: MockState) => unknown) => selector(mockState),
}));

vi.mock('../../lib/tauri', () => ({
  tauri: { openProjectInEditor },
}));

vi.mock('../../lib/openNotesWindow', () => ({ openNotesWindow }));

vi.mock('sonner', () => ({ toast: { error: toastError } }));

import { ProjectToolbar } from './ProjectToolbar';

function baseState(overrides: Partial<MockState> = {}): MockState {
  return {
    projects: [{ id: 4, name: 'Demo', path: '/demo' }],
    tabs: [{ id: 'tab-4', projectId: 4 }],
    activeTabId: 'tab-4',
    openNewTerminalTab,
    ...overrides,
  };
}

describe('ProjectToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openProjectInEditor.mockResolvedValue(undefined);
    openNotesWindow.mockResolvedValue(undefined);
    mockState = baseState();
  });

  it('routes all actions to the active project', async () => {
    render(<ProjectToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz w edytorze' }));
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz notatki' }));
    expect(openNewTerminalTab).toHaveBeenCalledWith(4);
    expect(openProjectInEditor).toHaveBeenCalledWith('/demo');
    expect(openNotesWindow).toHaveBeenCalledWith(4, 'Demo');
  });

  it('renders nothing without an active project', () => {
    mockState = baseState({ tabs: [], activeTabId: null });
    expect(render(<ProjectToolbar />).container).toBeEmptyDOMElement();
  });

  it('shows an editor launch failure', async () => {
    openProjectInEditor.mockRejectedValueOnce(new Error('failed'));
    render(<ProjectToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz w edytorze' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Nie udało się otworzyć projektu w edytorze'));
  });

  it('shows a notes launch failure', async () => {
    openNotesWindow.mockRejectedValueOnce(new Error('failed'));
    render(<ProjectToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz notatki' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Nie udało się otworzyć okna notatek'));
  });
});
