import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Action } from '../../types';

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  start: vi.fn(), stop: vi.fn(), dismiss: vi.fn(),
  upsert: vi.fn(), closeTab: vi.fn(), load: vi.fn(),
}));

vi.mock('../../lib/processManager', () => ({
  processManager: { start: h.start, stop: h.stop, dismiss: h.dismiss },
}));
vi.mock('../../store', () => ({ useStore: (sel: (s: unknown) => unknown) => sel(h.state) }));

import { ProjectActionsMenu } from './ProjectActionsMenu';

const actions: Action[] = [
  { id: 1, projectId: 7, label: 'build', command: 'b', workingDir: null, source: null, preCommand: null, sortOrder: 0 },
  { id: 2, projectId: 7, label: 'test', command: 't', workingDir: null, source: null, preCommand: null, sortOrder: 1 },
];

function seed(runningActions: Record<number, unknown>) {
  h.state = {
    actionsByProject: { 7: actions },
    runningActions,
    loadActions: h.load,
    upsertActionTab: h.upsert,
    closeTab: h.closeTab,
  };
}

describe('ProjectActionsMenu', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('starts a not-running action on click', () => {
    seed({});
    render(<ProjectActionsMenu projectId={7} onClose={() => {}} />);
    fireEvent.click(screen.getByText('build'));
    expect(h.start).toHaveBeenCalledWith(7, actions[0]);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('opens the tab for an already-running action on click', () => {
    seed({ 1: { actionId: 1, ptyId: 'p', status: 'running' } });
    render(<ProjectActionsMenu projectId={7} onClose={() => {}} />);
    fireEvent.click(screen.getByText('build'));
    expect(h.upsert).toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('re-runs an exited action via its restart button', () => {
    seed({ 1: { actionId: 1, ptyId: 'p', status: 'exited', exitCode: 0 } });
    render(<ProjectActionsMenu projectId={7} onClose={() => {}} />);
    fireEvent.click(screen.getByTitle('Uruchom ponownie'));
    expect(h.dismiss).toHaveBeenCalledWith(1);
    expect(h.start).toHaveBeenCalledWith(7, actions[0]);
  });
});
