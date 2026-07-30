import { useEffect } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';

const counters = vi.hoisted(() => ({ terminalMounts: 0 }));

vi.mock('../terminal/TerminalView', () => ({
  TerminalView: ({ visible }: { visible?: boolean }) => {
    useEffect(() => { counters.terminalMounts += 1; }, []);
    return <div data-testid="terminal" data-visible={String(visible)} />;
  },
}));
vi.mock('../history/HistoryView', () => ({ HistoryView: () => <div data-testid="history" /> }));
vi.mock('../history/SubagentView', () => ({ SubagentView: () => <div data-testid="subagent" /> }));

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
Element.prototype.scrollIntoView = vi.fn();

import { useStore } from '../../store';
import { PaneLayout } from './PaneLayout';
import { createLeaf, leaves } from '../../lib/paneTree';
import { ROOT_PANE_ID } from '../../store/panesSlice';
import type { Tab } from '../../store/tabsSlice';

const terminalTab = (id: string, title: string): Tab => ({ kind: 'terminal', id, projectId: 1, title });

describe('PaneLayout', () => {
  beforeEach(() => {
    counters.terminalMounts = 0;
    useStore.setState({
      tabs: [terminalTab('t1', 'Lewy'), terminalTab('t2', 'Prawy')],
      activeTabId: 't1',
      mruOrder: [],
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      layout: createLeaf(ROOT_PANE_ID, ['t1', 't2'], 't1'),
      focusedPaneId: ROOT_PANE_ID,
    });
  });

  it('positions a single pane over the whole area', () => {
    const { container } = render(<PaneLayout />);
    const region = container.querySelector(`[data-pane-id="${ROOT_PANE_ID}"]`) as HTMLElement;
    expect(region.style.left).toBe('0%');
    expect(region.style.width).toBe('100%');
  });

  it('positions two panes side by side after a split', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    const ids = leaves(useStore.getState().layout).map(l => l.id);
    const right = container.querySelector(`[data-pane-id="${ids[1]}"]`) as HTMLElement;
    expect(right.style.left).toBe('50%');
    expect(right.style.width).toBe('50%');
  });

  it('shows the active tab of every pane at once', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const visible = container.querySelectorAll('[data-testid="terminal"][data-visible="true"]');
    expect(visible).toHaveLength(2);
  });

  it('never remounts a terminal when its tab moves to another pane', () => {
    const { container } = render(<PaneLayout />);
    expect(counters.terminalMounts).toBe(2);
    const before = container.querySelector('[data-tab-layer="t2"]');

    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });

    expect(counters.terminalMounts).toBe(2);
    expect(container.querySelector('[data-tab-layer="t2"]')).toBe(before);
  });

  it('renders the empty-state hint when no tab is open', () => {
    act(() => {
      useStore.setState({ tabs: [], activeTabId: null, layout: createLeaf(ROOT_PANE_ID), focusedPaneId: ROOT_PANE_ID });
    });
    const { getByText } = render(<PaneLayout />);
    expect(getByText('Wybierz sesję z lewej')).toBeTruthy();
  });
});
