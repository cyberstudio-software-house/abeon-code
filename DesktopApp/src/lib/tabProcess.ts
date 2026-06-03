import type { Tab } from '../store/tabsSlice';
import type { RunningAction } from '../store/actionsSlice';

export function isTabLiveProcess(
  tab: Tab,
  runningActions: Record<number, RunningAction | undefined>,
): boolean {
  if (tab.kind === 'action') return runningActions[tab.actionId]?.status === 'running';
  return (tab.kind === 'session' && tab.mode === 'terminal') || tab.kind === 'terminal';
}
