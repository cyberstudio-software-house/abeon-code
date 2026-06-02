import type { RunningAction } from '../store/actionsSlice';

// 130 = SIGINT (Ctrl+C), 143 = SIGTERM — deliberate stops, not failures.
const STOP_SIGNAL_CODES = new Set([130, 143]);

export type ActionTone = 'idle' | 'running' | 'error' | 'stopped';

export function actionTone(r: RunningAction | undefined): ActionTone {
  if (!r) return 'idle';
  if (r.status === 'running') return 'running';
  if (r.exitCode == null || !STOP_SIGNAL_CODES.has(r.exitCode)) return 'error';
  return 'stopped';
}
