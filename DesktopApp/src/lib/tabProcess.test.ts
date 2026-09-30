import { describe, it, expect } from 'vitest';
import { closeConfirmMessage, isTabLiveProcess } from './tabProcess';
import type { Tab } from '../store/tabsSlice';

const sessionHistory: Tab = { kind: 'session', id: 's1', projectId: 1, sessionId: 'a', title: 't', mode: 'history' };
const sessionTerminal: Tab = { kind: 'session', id: 's2', projectId: 1, sessionId: 'b', title: 't', mode: 'terminal' };
const shell: Tab = { kind: 'terminal', id: 't1', projectId: 1, title: 'Terminal' };
const action: Tab = { kind: 'action', id: 'a1', projectId: 1, actionId: 5, title: 'Build', status: 'running' };

describe('isTabLiveProcess', () => {
  it('session in history mode is not live', () => {
    expect(isTabLiveProcess(sessionHistory, {})).toBe(false);
  });
  it('session in terminal mode is live', () => {
    expect(isTabLiveProcess(sessionTerminal, {})).toBe(true);
  });
  it('shell terminal is live', () => {
    expect(isTabLiveProcess(shell, {})).toBe(true);
  });
  it('action is live only when running', () => {
    expect(isTabLiveProcess(action, { 5: { status: 'running' } as never })).toBe(true);
    expect(isTabLiveProcess(action, { 5: { status: 'exited' } as never })).toBe(false);
    expect(isTabLiveProcess(action, {})).toBe(false);
  });
});

describe('drawer-aware close guard', () => {
  it('treats a history session with a drawer as live', () => {
    expect(isTabLiveProcess(sessionHistory, {}, { [sessionHistory.id]: {} })).toBe(true);
    expect(isTabLiveProcess(sessionHistory, {}, {})).toBe(false);
  });

  it('mentions how many drawer terminals will close', () => {
    expect(closeConfirmMessage(0)).toBe('W tym tabie działa aktywny proces. Zamknięcie zakończy go.');
    expect(closeConfirmMessage(2)).toBe('W tym tabie działa aktywny proces. Zamknięcie zakończy go. Zamknięte zostaną też terminale z panelu (2).');
  });
});
