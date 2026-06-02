import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Action } from '../../types';

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  start: vi.fn(), stop: vi.fn(), dismiss: vi.fn(),
  upsert: vi.fn(), closeTab: vi.fn(), removeAction: vi.fn(),
}));

vi.mock('../../lib/processManager', () => ({
  processManager: { start: h.start, stop: h.stop, dismiss: h.dismiss },
}));
vi.mock('../../store', () => ({ useStore: (sel: (s: unknown) => unknown) => sel(h.state) }));

import { ActionRow } from './ActionRow';

const action: Action = {
  id: 1, projectId: 7, label: 'build', command: 'echo hi',
  workingDir: null, source: null, preCommand: null, sortOrder: 0,
};

function seed(runningActions: Record<number, unknown>) {
  h.state = {
    runningActions,
    upsertActionTab: h.upsert,
    closeTab: h.closeTab,
    removeAction: h.removeAction,
  };
}

describe('ActionRow', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('runs the action in background when not running', () => {
    seed({});
    render(<ActionRow action={action} index={0} onChanged={() => {}} />);
    fireEvent.click(screen.getByTitle('Uruchom'));
    expect(h.start).toHaveBeenCalledWith(7, action);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('shows output tab and offers stop while running', () => {
    seed({ 1: { actionId: 1, ptyId: 'p', status: 'running' } });
    render(<ActionRow action={action} index={0} onChanged={() => {}} />);
    fireEvent.click(screen.getByTitle('Pokaż output'));
    expect(h.upsert).toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Zatrzymaj'));
    expect(h.stop).toHaveBeenCalledWith(1);
  });

  it('re-runs an exited action', () => {
    seed({ 1: { actionId: 1, ptyId: 'p', status: 'exited', exitCode: 0 } });
    render(<ActionRow action={action} index={0} onChanged={() => {}} />);
    fireEvent.click(screen.getByTitle('Uruchom ponownie'));
    expect(h.dismiss).toHaveBeenCalledWith(1);
    expect(h.start).toHaveBeenCalledWith(7, action);
  });
});
