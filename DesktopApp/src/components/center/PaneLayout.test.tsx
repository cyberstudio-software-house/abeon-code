import { useEffect } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

const counters = vi.hoisted(() => ({ terminalMounts: 0 }));

vi.mock('../terminal/TerminalView', () => ({
  TerminalView: ({ visible, focused }: { visible?: boolean; focused?: boolean }) => {
    useEffect(() => { counters.terminalMounts += 1; }, []);
    return (
      <div
        data-testid="terminal"
        data-visible={String(visible)}
        data-focused={String(!!focused)}
        onMouseDown={e => e.stopPropagation()}
      />
    );
  },
}));
vi.mock('../history/HistoryView', () => ({ HistoryView: () => <div data-testid="history" /> }));
vi.mock('../history/SubagentView', () => ({ SubagentView: () => <div data-testid="subagent" /> }));

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
// jsdom ships no PointerEvent, so fireEvent.pointerDown would drop clientX/button on a plain Event.
vi.stubGlobal('PointerEvent', class extends MouseEvent {});
Element.prototype.scrollIntoView = vi.fn();

import { useStore } from '../../store';
import { PaneLayout } from './PaneLayout';
import { MIN_PANE_WIDTH, TAB_BAR_HEIGHT } from '../../lib/paneGeometry';
import { createLeaf, findLeaf, leaves, type PaneNode, type PaneSplit } from '../../lib/paneTree';
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

  it('drops a stale drag when another handle is pressed', () => {
    act(() => {
      useStore.setState({
        tabs: [terminalTab('t1', 'Lewy'), terminalTab('t2', 'Środek'), terminalTab('t3', 'Prawy')],
        activeTabId: 't1',
        layout: {
          kind: 'split', id: 'outer', dir: 'row', sizes: [0.25, 0.75],
          children: [
            createLeaf('left', ['t1'], 't1'),
            {
              kind: 'split', id: 'inner', dir: 'row', sizes: [0.5, 0.5],
              children: [createLeaf('mid', ['t2'], 't2'), createLeaf('right', ['t3'], 't3')],
            },
          ],
        },
        focusedPaneId: 'left',
      });
    });
    const { container } = render(<PaneLayout />);
    stubBox(container.firstElementChild as HTMLElement, 1000, 800);
    const handles = Array.from(container.querySelectorAll('[role="separator"]')) as HTMLElement[];
    const outerHandle = handles.find(el => el.style.left === '25%') as HTMLElement;
    const innerHandle = handles.find(el => el.style.left === '62.5%') as HTMLElement;

    fireEvent.mouseDown(outerHandle, { clientX: 250, clientY: 400 });
    fireEvent.mouseDown(innerHandle, { clientX: 625, clientY: 400 });
    fireEvent.mouseMove(window, { clientX: 700, clientY: 400 });
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 900, clientY: 400 });

    const layout = useStore.getState().layout;
    const outer = findSplit(layout, 'outer') as PaneSplit;
    const inner = findSplit(layout, 'inner') as PaneSplit;
    expect(outer.sizes[0]).toBeCloseTo(0.25);
    expect(outer.sizes[1]).toBeCloseTo(0.75);
    expect(inner.sizes[0]).toBeCloseTo(0.6);
  });

  it('renders the empty-state hint when no tab is open', () => {
    act(() => {
      useStore.setState({ tabs: [], activeTabId: null, layout: createLeaf(ROOT_PANE_ID), focusedPaneId: ROOT_PANE_ID });
    });
    const { getByText } = render(<PaneLayout />);
    expect(getByText('Wybierz sesję z lewej')).toBeTruthy();
  });

  it('focuses a pane when its content area is clicked', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const ids = leaves(useStore.getState().layout).map(l => l.id);
    act(() => { useStore.getState().focusPane(ids[1]); });
    const { container } = render(<PaneLayout />);

    fireEvent.mouseDown(container.querySelector(`[data-pane-content="${ids[0]}"]`) as HTMLElement);

    expect(useStore.getState().focusedPaneId).toBe(ids[0]);
    expect(useStore.getState().activeTabId).toBe('t1');
  });

  it('focuses a pane when its tab bar region is clicked', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const ids = leaves(useStore.getState().layout).map(l => l.id);
    const { container } = render(<PaneLayout />);

    fireEvent.mouseDown(container.querySelector(`[data-pane-id="${ids[0]}"]`) as HTMLElement);

    expect(useStore.getState().focusedPaneId).toBe(ids[0]);
    expect(useStore.getState().activeTabId).toBe('t1');
  });

  it('focuses a pane even when the terminal swallows the mousedown', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const ids = leaves(useStore.getState().layout).map(l => l.id);
    const { container } = render(<PaneLayout />);

    fireEvent.mouseDown(
      container.querySelector(`[data-pane-content="${ids[0]}"] [data-testid="terminal"]`) as HTMLElement,
    );

    expect(useStore.getState().focusedPaneId).toBe(ids[0]);
  });

  it('marks only the focused pane terminal as focused', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    const focused = container.querySelectorAll('[data-testid="terminal"][data-focused="true"]');
    expect(focused).toHaveLength(1);
  });

  it('moves the focused terminal flag to the pane the user clicks into', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const ids = leaves(useStore.getState().layout).map(l => l.id);
    const { container } = render(<PaneLayout />);
    const flagOf = (tabId: string) =>
      container.querySelector(`[data-tab-layer="${tabId}"] [data-testid="terminal"]`)?.getAttribute('data-focused');
    expect(flagOf('t2')).toBe('true');
    expect(flagOf('t1')).toBe('false');

    fireEvent.mouseDown(container.querySelector(`[data-pane-content="${ids[0]}"]`) as HTMLElement);

    expect(flagOf('t1')).toBe('true');
    expect(flagOf('t2')).toBe('false');
  });

  it('records a cross-pane focus move in the MRU order and the navigation history', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const ids = leaves(useStore.getState().layout).map(l => l.id);
    act(() => { useStore.setState({ mruOrder: ['t2'], navHistory: ['t2'], navIndex: 0 }); });
    const { container } = render(<PaneLayout />);

    fireEvent.mouseDown(container.querySelector(`[data-pane-content="${ids[0]}"]`) as HTMLElement);

    expect(useStore.getState().mruOrder).toEqual(['t1', 't2']);
    expect(useStore.getState().navHistory).toEqual(['t2', 't1']);
    expect(useStore.getState().navIndex).toBe(1);
  });

  it('writes nothing to the store when clicking inside the already focused pane', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const ids = leaves(useStore.getState().layout).map(l => l.id);
    const { container } = render(<PaneLayout />);
    const layer = container.querySelector(`[data-pane-content="${ids[1]}"]`) as HTMLElement;
    let writes = 0;
    const unsubscribe = useStore.subscribe(() => { writes += 1; });

    fireEvent.mouseDown(layer);
    fireEvent.mouseDown(layer);
    unsubscribe();

    expect(useStore.getState().focusedPaneId).toBe(ids[1]);
    expect(writes).toBe(0);
  });

  const pointerAt = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1, button: 0 });

  const stubContainerBox = (container: HTMLElement) => {
    const root = container.firstElementChild as HTMLElement;
    root.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, toJSON: () => ({}) });
  };

  const stubTabBoxes = (container: HTMLElement, paneId: string, firstLeft: number, width: number) => {
    const bar = container.querySelector(`[data-pane-id="${paneId}"]`) as HTMLElement;
    Array.from(bar.querySelectorAll('[data-tab-id]')).forEach((el, i) => {
      const left = firstLeft + i * width;
      (el as HTMLElement).getBoundingClientRect = () => ({
        x: left, y: 0, left, top: 0, right: left + width, bottom: TAB_BAR_HEIGHT,
        width, height: TAB_BAR_HEIGHT, toJSON: () => ({}),
      });
    });
  };

  it('splits the pane when a tab is dropped on its right edge', () => {
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    const tab = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(10, 10));
    fireEvent.pointerMove(window, pointerAt(960, 400));
    fireEvent.pointerUp(window, pointerAt(960, 400));

    expect(leaves(useStore.getState().layout)).toHaveLength(2);
    expect(useStore.getState().activeTabId).toBe('t2');
  });

  it('ignores a pointer movement below the drag threshold', () => {
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    const tab = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(10, 10));
    fireEvent.pointerMove(window, pointerAt(12, 11));
    expect(container.querySelector('[data-drop-preview]')).toBeNull();
    fireEvent.pointerUp(window, pointerAt(12, 11));

    expect(leaves(useStore.getState().layout)).toHaveLength(1);
    expect(useStore.getState().activeTabId).toBe('t1');
  });

  it('moves the tab without splitting when dropped in the centre of another pane', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    const ids = leaves(useStore.getState().layout).map(l => l.id);
    const tab = container.querySelector('[data-tab-id="t1"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(10, 10));
    fireEvent.pointerMove(window, pointerAt(750, 400));
    fireEvent.pointerUp(window, pointerAt(750, 400));

    expect(leaves(useStore.getState().layout)).toHaveLength(1);
    expect(useStore.getState().layout).toMatchObject({ id: ids[1] });
  });

  it('never starts a drag from a middle-click on a tab', () => {
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    const tab = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    fireEvent.pointerDown(tab, { ...pointerAt(10, 10), button: 1 });
    fireEvent.pointerMove(window, pointerAt(960, 400));
    fireEvent.pointerUp(window, pointerAt(960, 400));

    expect(leaves(useStore.getState().layout)).toHaveLength(1);
  });

  it('offers no edge zone when the split would fall below the minimum pane width', () => {
    const { container } = render(<PaneLayout />);
    stubBox(container.firstElementChild as HTMLElement, MIN_PANE_WIDTH * 2 - 40, 800);
    const tab = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(10, 10));
    fireEvent.pointerMove(window, pointerAt(MIN_PANE_WIDTH * 2 - 45, 400));
    expect(container.querySelector('[data-drop-preview]')).toBeNull();
    fireEvent.pointerUp(window, pointerAt(MIN_PANE_WIDTH * 2 - 45, 400));

    expect(leaves(useStore.getState().layout)).toHaveLength(1);
    expect(findLeaf(useStore.getState().layout, ROOT_PANE_ID)?.tabIds).toEqual(['t1', 't2']);
  });

  it('drops a stale tab drag when another tab is pressed', () => {
    act(() => {
      useStore.setState({
        tabs: [terminalTab('t1', 'Jeden'), terminalTab('t2', 'Dwa'), terminalTab('t3', 'Trzy')],
        activeTabId: 't1',
        layout: createLeaf(ROOT_PANE_ID, ['t1', 't2', 't3'], 't1'),
        focusedPaneId: ROOT_PANE_ID,
      });
    });
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);

    fireEvent.pointerDown(container.querySelector('[data-tab-id="t1"]') as HTMLElement, pointerAt(10, 10));
    fireEvent.pointerDown(container.querySelector('[data-tab-id="t2"]') as HTMLElement, pointerAt(50, 10));
    fireEvent.pointerMove(window, pointerAt(960, 400));
    fireEvent.pointerUp(window, pointerAt(960, 400));

    expect(leaves(useStore.getState().layout)).toHaveLength(2);
    expect(findLeaf(useStore.getState().layout, ROOT_PANE_ID)?.tabIds).toEqual(['t1', 't3']);
  });

  it('cancels the drag when the tab is dropped outside the container', () => {
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    const tab = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(10, 10));
    fireEvent.pointerMove(window, pointerAt(1400, 400));
    fireEvent.pointerUp(window, pointerAt(1400, 400));

    expect(leaves(useStore.getState().layout)).toHaveLength(1);
    expect(findLeaf(useStore.getState().layout, ROOT_PANE_ID)?.tabIds).toEqual(['t1', 't2']);
  });

  it('previews the half a pane edge drop would create and clears it on release', () => {
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    const tab = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(10, 10));
    fireEvent.pointerMove(window, pointerAt(960, 400));

    const preview = container.querySelector('[data-drop-preview]') as HTMLElement;
    expect(preview.style.left).toBe('50%');
    expect(preview.style.width).toBe('50%');
    expect(preview.style.height).toBe('100%');

    fireEvent.pointerUp(window, pointerAt(960, 400));

    expect(container.querySelector('[data-drop-preview]')).toBeNull();
  });

  it('inserts a tab dropped on another pane tab bar at the pointed slot', () => {
    act(() => {
      useStore.setState({
        tabs: [terminalTab('t1', 'Jeden'), terminalTab('t2', 'Dwa'), terminalTab('t3', 'Trzy')],
        activeTabId: 't1',
        layout: {
          kind: 'split', id: 'outer', dir: 'row', sizes: [0.5, 0.5],
          children: [createLeaf('left', ['t1'], 't1'), createLeaf('right', ['t2', 't3'], 't2')],
        },
        focusedPaneId: 'left',
      });
    });
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    stubTabBoxes(container, 'right', 500, 100);
    const tab = container.querySelector('[data-tab-id="t1"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(50, 10));
    fireEvent.pointerMove(window, pointerAt(600, 10));
    fireEvent.pointerUp(window, pointerAt(600, 10));

    expect(findLeaf(useStore.getState().layout, 'right')?.tabIds).toEqual(['t2', 't1', 't3']);
  });

  it('drops a tab reordered inside its own pane at the slot the indicator showed', () => {
    act(() => {
      useStore.setState({
        tabs: [terminalTab('t1', 'Jeden'), terminalTab('t2', 'Dwa'), terminalTab('t3', 'Trzy')],
        activeTabId: 't1',
        layout: createLeaf(ROOT_PANE_ID, ['t1', 't2', 't3'], 't1'),
        focusedPaneId: ROOT_PANE_ID,
      });
    });
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    stubTabBoxes(container, ROOT_PANE_ID, 0, 100);
    const tab = container.querySelector('[data-tab-id="t1"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(50, 10));
    fireEvent.pointerMove(window, pointerAt(200, 10));
    fireEvent.pointerUp(window, pointerAt(200, 10));

    expect(findLeaf(useStore.getState().layout, ROOT_PANE_ID)?.tabIds).toEqual(['t2', 't1', 't3']);
  });
});
