import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

type MockState = Record<string, unknown>;
let mockState: MockState;

vi.mock('../../store', () => ({
  useStore: (sel: (s: MockState) => unknown) => sel(mockState),
}));

import { ClickUpSection } from './ClickUpSection';

function baseState(overrides: Partial<MockState> = {}): MockState {
  return {
    tabs: [{ id: 'tab-1', projectId: 1 }],
    activeTabId: 'tab-1',
    connectionStatus: 'configured',
    linksByProject: {
      1: [{ projectId: 1, taskId: 'task-1', customId: 'CU-1', name: 'Alpha', status: 'open', url: 'u', linkedAt: 1 }],
    },
    configByProject: { 1: { projectId: 1, workspaceId: 'w', spaceId: 's', listId: null } },
    loadLinks: vi.fn(),
    loadConfig: vi.fn(),
    loadConnectionStatus: vi.fn(),
    ...overrides,
  };
}

describe('ClickUpSection', () => {
  beforeEach(() => {
    mockState = baseState();
  });

  it('renders linked task names', () => {
    render(<ClickUpSection />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('renders nothing when the token is absent', () => {
    mockState = baseState({ connectionStatus: 'absent' });
    const { container } = render(<ClickUpSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('prompts to fix an invalid token', () => {
    mockState = baseState({ connectionStatus: 'invalid' });
    render(<ClickUpSection />);
    expect(screen.getByText(/nieprawidłowy/i)).toBeInTheDocument();
  });

  it('prompts to set scope when connected without config', () => {
    mockState = baseState({ configByProject: { 1: null } });
    render(<ClickUpSection />);
    expect(screen.getByText(/Ustaw zakres/i)).toBeInTheDocument();
  });

  it('shows an empty state when there are no linked tasks', () => {
    mockState = baseState({ linksByProject: { 1: [] } });
    render(<ClickUpSection />);
    expect(screen.getByText(/Brak powiązanych zadań/i)).toBeInTheDocument();
  });

  it('renders nothing when there is no active project', () => {
    mockState = baseState({ tabs: [], activeTabId: null });
    const { container } = render(<ClickUpSection />);
    expect(container).toBeEmptyDOMElement();
  });
});
