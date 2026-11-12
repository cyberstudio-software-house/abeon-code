import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = Record<string, unknown>;
let mockState: MockState;

const { openTerminal, openNotesPanel, openFilesPanel, openProjectInEditor, toastError } = vi.hoisted(() => ({
  openTerminal: vi.fn(),
  openNotesPanel: vi.fn(),
  openFilesPanel: vi.fn(),
  openProjectInEditor: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../store', () => ({
  useStore: (selector: (state: MockState) => unknown) => selector(mockState),
}));

vi.mock('../../lib/tauri', () => ({
  tauri: { openProjectInEditor },
}));

vi.mock('sonner', () => ({ toast: { error: toastError } }));

import { ProjectToolbar } from './ProjectToolbar';

function baseState(overrides: Partial<MockState> = {}): MockState {
  return {
    projects: [{ id: 4, name: 'Demo', path: '/demo' }],
    tabs: [{ id: 'tab-4', projectId: 4 }],
    activeTabId: 'tab-4',
    openTerminal,
    openNotesPanel,
    openFilesPanel,
    ...overrides,
  };
}

describe('ProjectToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openProjectInEditor.mockResolvedValue(undefined);
    mockState = baseState();
  });

  it('routes all actions to the active project', async () => {
    render(<ProjectToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edytor' }));
    expect(openTerminal).toHaveBeenCalledWith(4, { toggle: false });
    expect(openProjectInEditor).toHaveBeenCalledWith('/demo');
  });

  it('opens the notes panel', () => {
    render(<ProjectToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Notatki' }));
    expect(openNotesPanel).toHaveBeenCalledTimes(1);
  });

  it('opens the files panel', () => {
    render(<ProjectToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Pliki' }));
    expect(openFilesPanel).toHaveBeenCalledTimes(1);
  });

  it('lays the four actions out in four columns', () => {
    render(<ProjectToolbar />);
    expect(screen.getByRole('group', { name: 'Otwórz projekt w' })).toHaveClass('grid-cols-4');
  });

  it('renders the four actions without a pressed state', () => {
    render(<ProjectToolbar />);
    for (const name of ['Terminal', 'Edytor', 'Notatki', 'Pliki']) {
      expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-pressed');
    }
  });

  it('renders nothing without an active project', () => {
    mockState = baseState({ tabs: [], activeTabId: null });
    expect(render(<ProjectToolbar />).container).toBeEmptyDOMElement();
  });

  it('shows an editor launch failure', async () => {
    openProjectInEditor.mockRejectedValueOnce(new Error('failed'));
    render(<ProjectToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Edytor' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Nie udało się otworzyć projektu w edytorze'));
  });
});
