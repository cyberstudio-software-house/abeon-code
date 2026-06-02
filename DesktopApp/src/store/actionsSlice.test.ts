import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';

describe('actionsSlice running status', () => {
  beforeEach(() => { useStore.setState({ runningActions: {} }); });

  it('setActionRunning adds a running entry', () => {
    useStore.getState().setActionRunning(5, 'pty-x');
    expect(useStore.getState().runningActions[5]).toEqual({ actionId: 5, ptyId: 'pty-x', status: 'running' });
  });

  it('setActionExited keeps ptyId and records exitCode', () => {
    useStore.getState().setActionRunning(5, 'pty-x');
    useStore.getState().setActionExited(5, 1);
    expect(useStore.getState().runningActions[5]).toEqual({ actionId: 5, ptyId: 'pty-x', status: 'exited', exitCode: 1 });
  });

  it('setActionExited is a no-op when action is not running', () => {
    useStore.getState().setActionExited(5, 1);
    expect(useStore.getState().runningActions[5]).toBeUndefined();
  });

  it('clearAction removes the entry', () => {
    useStore.getState().setActionRunning(5, 'pty-x');
    useStore.getState().clearAction(5);
    expect(useStore.getState().runningActions[5]).toBeUndefined();
  });
});
