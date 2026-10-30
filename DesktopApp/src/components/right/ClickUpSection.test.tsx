import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

type MockState = Record<string, unknown>;
let mockState: MockState;

vi.mock('../../store', () => ({
  useStore: (sel: (s: MockState) => unknown) => sel(mockState),
}));

vi.mock('../dialogs/LinkClickUpTaskDialog', () => ({
  LinkClickUpTaskDialog: () => <div data-testid="link-dialog" />,
}));
vi.mock('../dialogs/ClickUpTaskDialog', () => ({
  ClickUpTaskDialog: () => <div data-testid="task-dialog" />,
}));
vi.mock('./ClickUpScopeDialog', () => ({
  ClickUpScopeDialog: () => <div data-testid="scope-dialog" />,
}));

import { ClickUpSection } from './ClickUpSection';

function baseState(overrides: Partial<MockState> = {}): MockState {
  return {
    tabs: [{ id: 'tab-1', projectId: 1 }],
    activeTabId: 'tab-1',
    connectionStatus: 'configured',
    linksByProject: {
      1: [
        { projectId: 1, taskId: 'task-1', customId: 'CU-1', name: 'Alpha', status: 'open', url: 'u', linkedAt: 1 },
        { projectId: 1, taskId: 'abcdef123', customId: null, name: 'Beta', status: null, url: 'u', linkedAt: 2 },
      ],
    },
    configByProject: { 1: { projectId: 1, workspaceId: 'w', spaceId: 's', listId: null } },
    loadLinks: vi.fn(),
    loadConfig: vi.fn(),
    loadConnectionStatus: vi.fn(),
    openSettings: vi.fn(),
    ...overrides,
  };
}

describe('ClickUpSection', () => {
  beforeEach(() => {
    mockState = baseState();
  });

  it('lists linked tasks with id, name and status', () => {
    render(<ClickUpSection />);
    expect(screen.getByText('Zadania ClickUp')).toBeInTheDocument();
    expect(screen.getByText('CU-1')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('abcdef')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Powiąż zadania' })).toBeInTheDocument();
  });

  it('opens the scope dialog from the header button', () => {
    render(<ClickUpSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Zakres ClickUp' }));
    expect(screen.getByTestId('scope-dialog')).toBeInTheDocument();
  });

  it('opens the task dialog from a row', () => {
    render(<ClickUpSection />);
    fireEvent.click(screen.getByText('Alpha'));
    expect(screen.getByTestId('task-dialog')).toBeInTheDocument();
  });

  it('shows the empty state with Powiąż zadania', () => {
    mockState = baseState({ linksByProject: { 1: [] } });
    render(<ClickUpSection />);
    expect(screen.getByText('Ten projekt nie ma jeszcze powiązanych zadań.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Powiąż zadania' }));
    expect(screen.getByTestId('link-dialog')).toBeInTheDocument();
  });

  it('asks for a scope', () => {
    mockState = baseState({ configByProject: { 1: null } });
    render(<ClickUpSection />);
    expect(screen.getByText('Wybierz workspace i space, z których mają pochodzić zadania tego projektu.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ustaw zakres' }));
    expect(screen.getByTestId('scope-dialog')).toBeInTheDocument();
  });

  it('sends an invalid token to the ClickUp settings', () => {
    const openSettings = vi.fn();
    mockState = baseState({ connectionStatus: 'invalid', openSettings });
    render(<ClickUpSection />);
    expect(screen.getByText('Token ClickUp jest nieprawidłowy albo wygasł. Zadania nie będą się odświeżać.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz ustawienia ClickUp' }));
    expect(openSettings).toHaveBeenCalledWith('clickup');
  });

  it('keeps focus off the settings button on mousedown', () => {
    mockState = baseState({ connectionStatus: 'invalid' });
    render(<ClickUpSection />);
    const notPrevented = fireEvent.mouseDown(screen.getByRole('button', { name: 'Otwórz ustawienia ClickUp' }));
    expect(notPrevented).toBe(false);
  });

  it('explains where to fix the token in a detached window', () => {
    mockState = baseState({ connectionStatus: 'invalid' });
    render(<ClickUpSection detached />);
    expect(screen.getByText('Popraw token w ustawieniach głównego okna.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Otwórz ustawienia ClickUp' })).not.toBeInTheDocument();
  });

  it('stays hidden without a token', () => {
    mockState = baseState({ connectionStatus: 'absent' });
    const { container } = render(<ClickUpSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there is no active project', () => {
    mockState = baseState({ tabs: [], activeTabId: null });
    const { container } = render(<ClickUpSection />);
    expect(container).toBeEmptyDOMElement();
  });
});
