// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createLeaf, insertBeside } from './paneTree';
import { visibleSessionIds } from './visibleTabs';
import type { Tab } from '../store/tabsSlice';

const session = (id: string, sessionId: string, linked?: string): Tab => ({
  kind: 'session', id, projectId: 1, sessionId, title: id, mode: 'terminal',
  ...(linked ? { linkedSessionId: linked } : {}),
});

describe('visibleSessionIds', () => {
  it('returns the active session of every pane, preferring the linked id', () => {
    const layout = insertBeside(createLeaf('p1', ['a', 'b'], 'a'), 'p1', 'row', false, createLeaf('p2', ['c'], 'c'), 's1');
    const tabs = [session('a', 's-a'), session('b', 's-b'), session('c', 'new-x', 's-real')];
    expect(visibleSessionIds(layout, tabs)).toEqual(['s-a', 's-real']);
  });

  it('skips panes whose active tab is not a session', () => {
    const layout = createLeaf('p1', ['t1'], 't1');
    const tabs: Tab[] = [{ kind: 'terminal', id: 't1', projectId: 1, title: 'Terminal' }];
    expect(visibleSessionIds(layout, tabs)).toEqual([]);
  });
});
