import type { Tab } from '../store/tabsSlice';
import type { RunningAction } from '../store/actionsSlice';

export function isTabLiveProcess(
  tab: Tab,
  runningActions: Record<number, RunningAction | undefined>,
  drawers: Readonly<Record<string, unknown>> = {},
): boolean {
  if (tab.kind === 'action') return runningActions[tab.actionId]?.status === 'running';
  if (tab.kind === 'session') return tab.mode === 'terminal' || drawers[tab.id] !== undefined;
  return tab.kind === 'terminal';
}

const CLOSE_MESSAGE = 'W tym tabie działa aktywny proces. Zamknięcie zakończy go.';

export function closeConfirmMessage(drawerTerminalCount: number): string {
  if (drawerTerminalCount === 0) return CLOSE_MESSAGE;
  return `${CLOSE_MESSAGE} Zamknięte zostaną też terminale z panelu (${drawerTerminalCount}).`;
}
