import { describe, it, expect } from 'vitest';
import { actionTone } from './actionStatus';
import type { RunningAction } from '../store/actionsSlice';

const ra = (status: 'running' | 'exited', exitCode?: number): RunningAction =>
  ({ actionId: 1, ptyId: 'p', status, exitCode });

describe('actionTone', () => {
  it('returns idle when there is no running entry', () => {
    expect(actionTone(undefined)).toBe('idle');
  });
  it('returns running while the process is alive', () => {
    expect(actionTone(ra('running'))).toBe('running');
  });
  it('returns stopped for a clean exit (0), signal exits, and a missing code', () => {
    expect(actionTone(ra('exited', 0))).toBe('stopped');
    expect(actionTone(ra('exited', 130))).toBe('stopped');
    expect(actionTone(ra('exited', 143))).toBe('stopped');
    expect(actionTone(ra('exited', undefined))).toBe('stopped');
  });
  it('returns error for non-zero non-signal exit codes', () => {
    expect(actionTone(ra('exited', 1))).toBe('error');
    expect(actionTone(ra('exited', 2))).toBe('error');
  });
});
