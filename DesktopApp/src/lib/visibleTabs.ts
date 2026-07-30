import { leaves, type PaneNode } from './paneTree';
import type { Tab } from '../store/tabsSlice';

export function visibleSessionIds(layout: PaneNode, tabs: Tab[]): string[] {
  return leaves(layout)
    .map(leaf => tabs.find(t => t.id === leaf.activeTabId))
    .filter((t): t is Extract<Tab, { kind: 'session' }> => t?.kind === 'session')
    .map(t => t.linkedSessionId ?? t.sessionId);
}
