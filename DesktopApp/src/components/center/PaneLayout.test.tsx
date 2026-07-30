import { useEffect } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

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
import { createLeaf, leaves, type PaneNode, type PaneSplit } from '../../lib/paneTree';
import { ROOT_PANE_ID } from '../../store/panesSlice';
import type { Tab } from '../../store/tabsSlice';

const terminalTab = (id: string, title: string): Tab => ({ kind: 'terminal', id, projectId: 1, title });

function stubBox(el: HTMLElement, width: number, height: number) {
  el.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}),
  });
}

function findSplit(node: PaneNode, splitId: string): PaneSplit | null {
  if (node.kind === 'leaf') return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const found = findSplit(child, splitId);
    if (found) return found;
  }
  return null;
}

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

  it('renders a resizer for each split boundary', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  it('turns a drag into fractions of the dragged split', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    stubBox(container.firstElementChild as HTMLElement, 1000, 800);
    const handle = container.querySelector('[role="separator"]') as HTMLElement;

    fireEvent.mouseDown(handle, { clientX: 500, clientY: 400 });
    fireEvent.mouseMove(window, { clientX: 600, clientY: 400 });

    const root = useStore.getState().layout as PaneSplit;
    expect(root.sizes[0]).toBeCloseTo(0.6);
    expect(root.sizes[1]).toBeCloseTo(0.4);
  });

  it('scales a drag by the extent of the nested split it belongs to', () => {
    act(() => {
      useStore.setState({
        tabs: [terminalTab('t1', 'Lewy'), terminalTab('t2', 'Środek'), terminalTab('t3', 'Prawy')],
        activeTabId: 't1',
        layout: {
          kind: 'split',
          id: 'outer',
          dir: 'row',
          sizes: [0.25, 0.75],
          children: [
            createLeaf('left', ['t1'], 't1'),
            {
              kind: 'split',
              id: 'inner',
              dir: 'row',
              sizes: [0.5, 0.5],
              children: [createLeaf('mid', ['t2'], 't2'), createLeaf('right', ['t3'], 't3')],
            },
          ],
        },
        focusedPaneId: 'left',
      });
    });
    const { container } = render(<PaneLayout />);
    stubBox(container.firstElementChild as HTMLElement, 1000, 800);
    const handles = Array.from(container.querySelectorAll('[role="separator"]'));
    expect(handles).toHaveLength(2);
    const handle = handles.find(el => (el as HTMLElement).style.left === '62.5%') as HTMLElement;

    fireEvent.mouseDown(handle, { clientX: 625, clientY: 400 });
    fireEvent.mouseMove(window, { clientX: 700, clientY: 400 });

    const inner = findSplit(useStore.getState().layout, 'inner') as PaneSplit;
    expect(inner.sizes[0]).toBeCloseTo(0.6);
    expect(inner.sizes[1]).toBeCloseTo(0.4);
  });

  it('ignores a drag while the container has no measurable size', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    const handle = container.querySelector('[role="separator"]') as HTMLElement;

    fireEvent.mouseDown(handle, { clientX: 500, clientY: 400 });
    fireEvent.mouseMove(window, { clientX: 500, clientY: 500 });

    const root = useStore.getState().layout as PaneSplit;
    expect(root.sizes[0]).toBeCloseTo(0.5);
    expect(root.sizes[1]).toBeCloseTo(0.5);
  });

  it('stops following the pointer after the mouse is released', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    stubBox(container.firstElementChild as HTMLElement, 1000, 800);
    const handle = container.querySelector('[role="separator"]') as HTMLElement;

    fireEvent.mouseDown(handle, { clientX: 500, clientY: 400 });
    fireEvent.mouseMove(window, { clientX: 600, clientY: 400 });
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 900, clientY: 400 });

    const root = useStore.getState().layout as PaneSplit;
    expect(root.sizes[0]).toBeCloseTo(0.6);
  });

  it('renders the empty-state hint when no tab is open', () => {
    act(() => {
      useStore.setState({ tabs: [], activeTabId: null, layout: createLeaf(ROOT_PANE_ID), focusedPaneId: ROOT_PANE_ID });
    });
    const { getByText } = render(<PaneLayout />);
    expect(getByText('Wybierz sesję z lewej')).toBeTruthy();
  });
});
