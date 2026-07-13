import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { toast } from 'sonner';
import type { Tab } from '../store/tabsSlice';
import type { RunningAction } from '../store/actionsSlice';
import { buildGroupWindowUrl, groupWindowLabel, type DetachedTab } from './windowMode';
import { processManager } from './processManager';
import { tauri } from './tauri';

export type DetachSummary = { sessions: number; terminals: number; runningActions: number };

type ActionMap = Record<number, RunningAction | undefined>;

export function summarizeDetach(tabs: Tab[], runningActions: ActionMap): DetachSummary {
  let sessions = 0;
  let terminals = 0;
  let running = 0;
  for (const tab of tabs) {
    if (tab.kind === 'session' && tab.mode === 'terminal') sessions++;
    else if (tab.kind === 'terminal') terminals++;
    else if (tab.kind === 'action' && runningActions[tab.actionId]?.status === 'running') running++;
  }
  return { sessions, terminals, runningActions: running };
}

function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return `${n} ${one}`;
  const rest = n % 10;
  const teens = n % 100;
  if (rest >= 2 && rest <= 4 && (teens < 12 || teens > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export function detachSummaryMessage(s: DetachSummary): string | null {
  const parts: string[] = [];
  if (s.sessions > 0) {
    parts.push(`${plural(s.sessions, 'sesja zostanie uruchomiona', 'sesje zostaną uruchomione', 'sesji zostanie uruchomionych')} od nowa ze wznowieniem kontekstu`);
  }
  if (s.terminals > 0) {
    parts.push(`${plural(s.terminals, 'terminal straci', 'terminale stracą', 'terminali straci')} historię powłoki`);
  }
  if (s.runningActions > 0) {
    parts.push(`${plural(s.runningActions, 'akcja zostanie przejęta', 'akcje zostaną przejęte', 'akcji zostanie przejętych')} bez wcześniejszych logów`);
  }
  if (parts.length === 0) return null;
  return `${parts.join(', ')}.`;
}

export function buildDetachPayload(tabs: Tab[], runningActions: ActionMap): DetachedTab[] {
  return tabs.map((tab): DetachedTab => {
    if (tab.kind === 'session') {
      return {
        kind: 'session',
        id: tab.id,
        sessionId: tab.sessionId,
        ...(tab.linkedSessionId ? { linkedSessionId: tab.linkedSessionId } : {}),
        title: tab.title,
        mode: tab.mode,
        ...(tab.fresh ? { fresh: true } : {}),
        ...(tab.preview ? { preview: true } : {}),
        ...(tab.provider ? { provider: tab.provider } : {}),
      };
    }
    if (tab.kind === 'action') {
      const running = runningActions[tab.actionId];
      const ptyId = running?.status === 'running' ? running.ptyId : undefined;
      return {
        kind: 'action',
        id: tab.id,
        actionId: tab.actionId,
        title: tab.title,
        status: tab.status,
        ...(tab.exitCode != null ? { exitCode: tab.exitCode } : {}),
        ...(ptyId ? { ptyId } : {}),
      };
    }
    if (tab.kind === 'terminal') {
      return { kind: 'terminal', id: tab.id, title: tab.title };
    }
    return { kind: 'providerPicker', id: tab.id, title: tab.title };
  });
}

export async function detachProjectGroup(args: {
  projectId: number;
  projectName: string;
  tabs: Tab[];
  activeTabId: string | null;
  runningActions: ActionMap;
  detachTabs: (ids: string[]) => void;
}): Promise<void> {
  const { projectId, projectName, tabs, activeTabId, runningActions, detachTabs } = args;
  if (tabs.length === 0) return;

  const label = groupWindowLabel(projectId);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const actionTabs = tabs.filter(t => t.kind === 'action');
  const plainTabs = tabs.filter(t => t.kind !== 'action');
  const active = tabs.some(t => t.id === activeTabId) ? activeTabId : null;

  const url = buildGroupWindowUrl({
    projectId,
    tabs: buildDetachPayload(tabs, runningActions),
    activeTabId: active,
  });

  // Action PTYs outlive the move: the new window adopts them by id, so they are
  // released here only once it reports back. Releasing earlier would drop the
  // output emitted in the gap.
  const unlistenReady = await tauri.onDetachReady((readyLabel) => {
    if (readyLabel !== label) return;
    for (const tab of actionTabs) {
      if (tab.kind === 'action') processManager.release(tab.actionId);
    }
    if (actionTabs.length > 0) detachTabs(actionTabs.map(t => t.id));
    unlistenReady();
  });

  const win = new WebviewWindow(label, {
    url,
    title: projectName,
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 500,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
  });

  let unlistenCreated: (() => void) | undefined;
  let unlistenError: (() => void) | undefined;

  unlistenCreated = await win.once('tauri://created', () => {
    if (plainTabs.length > 0) detachTabs(plainTabs.map(t => t.id));
    unlistenError?.();
  });
  unlistenError = await win.once('tauri://error', (e) => {
    console.error('[detach] group window create failed', e);
    toast.error('Nie udało się otworzyć okna projektu');
    unlistenReady();
    unlistenCreated?.();
  });
}
