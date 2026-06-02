import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../lib/processManager', () => ({ processManager: { dismiss: vi.fn() } }));

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

Element.prototype.scrollIntoView = vi.fn();

import { processManager } from '../../lib/processManager';
import { useStore } from '../../store';
import { TabBar } from './TabBar';

function seedActionTab(status: 'running' | 'exited', exitCode?: number) {
  useStore.setState({
    tabs: [{ kind: 'action', id: 'action:1', projectId: 1, actionId: 1, title: 'build', status, ...(exitCode != null ? { exitCode } : {}) }],
    activeTabId: 'action:1',
    mruOrder: ['action:1'],
    runningActions: { 1: { actionId: 1, ptyId: 'p', status, exitCode } },
    projects: [{ id: 1, name: 'P', path: '/p' }] as never,
  });
}

describe('TabBar action close', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('closes an exited action tab immediately and dismisses the process', () => {
    seedActionTab('exited', 0);
    render(<TabBar />);
    fireEvent.click(screen.getByText('×'));
    expect(screen.queryByText('Zamknąć aktywny tab?')).toBeNull();
    expect(processManager.dismiss).toHaveBeenCalledWith(1);
    expect(useStore.getState().tabs).toHaveLength(0);
  });

  it('asks for confirmation when the action process is still running', () => {
    seedActionTab('running');
    render(<TabBar />);
    fireEvent.click(screen.getByText('×'));
    expect(screen.getByText('Zamknąć aktywny tab?')).toBeInTheDocument();
    expect(useStore.getState().tabs).toHaveLength(1);
  });

  it('colors the action tab icon from runningActions (error exit → danger)', () => {
    seedActionTab('exited', 2);
    const { container } = render(<TabBar />);
    const danger = container.querySelector('.text-danger');
    expect(danger?.textContent).toBe('▶');
  });
});
