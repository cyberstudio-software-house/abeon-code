import { useEffect } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';

const counters = vi.hoisted(() => ({ terminalMounts: 0 }));

vi.mock('../terminal/TerminalView', () => ({
  TerminalView: ({ visible, focused, takeFocus, onExit }: { visible?: boolean; focused?: boolean; takeFocus?: boolean; onExit?: (code: number) => void }) => {
    useEffect(() => { counters.terminalMounts += 1; }, []);
    return (
      <div
        data-testid="terminal"
        data-visible={String(visible)}
        data-focused={String(!!focused)}
        data-take-focus={String(takeFocus ?? !!focused)}
        onMouseDown={e => e.stopPropagation()}
      >
        {onExit ? <button data-testid="exit" onClick={() => onExit(0)} /> : null}
      </div>
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
import { MIN_PANE_HEIGHT, MIN_PANE_WIDTH, PANE_BAR_HEIGHT } from '../../lib/paneGeometry';
import { PANE_BORDER, PANE_GAP } from '../../lib/drawerGeometry';
import { createLeaf, findLeaf, leaves, type PaneNode, type PaneSplit } from '../../lib/paneTree';
import { ROOT_PANE_ID } from '../../store/panesSlice';
import type { Tab } from '../../store/tabsSlice';

const terminalTab = (id: string, title: string): Tab => ({ kind: 'terminal', id, projectId: 1, title });
const terminalTabIn = (id: string, title: string, projectId: number): Tab => ({ kind: 'terminal', id, projectId, title });

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
    expect(region.style.left).toBe('calc(0% + 5px)');
    expect(region.style.width).toBe('calc(100% - 10px)');
  });

  it('positions two panes side by side after a split', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    const ids = leaves(useStore.getState().layout).map(l => l.id);
    const right = container.querySelector(`[data-pane-id="${ids[1]}"]`) as HTMLElement;
    expect(right.style.left).toBe('calc(50% + 5px)');
    expect(right.style.width).toBe('calc(50% - 10px)');
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

  it('draws one frame per pane after every content layer', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    const frames = Array.from(container.querySelectorAll('[data-pane-frame]'));
    const layers = Array.from(container.querySelectorAll('[data-tab-layer]'));
    expect(frames.map(f => f.getAttribute('data-pane-frame'))).toEqual(leaves(useStore.getState().layout).map(l => l.id));
    expect(layers).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.parentElement).toBe(layers[0].parentElement);
      for (const layer of layers) {
        expect(layer.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    }
  });

  it('paints one card surface per pane before every content layer', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    const surfaces = Array.from(container.querySelectorAll('[data-pane-surface]')) as HTMLElement[];
    const layers = Array.from(container.querySelectorAll('[data-tab-layer]'));
    const bars = Array.from(container.querySelectorAll('[data-pane-id]'));
    expect(surfaces.map(el => el.getAttribute('data-pane-surface'))).toEqual(leaves(useStore.getState().layout).map(l => l.id));
    for (const surface of surfaces) {
      expect(surface.parentElement).toBe(layers[0].parentElement);
      expect(surface.getAttribute('aria-hidden')).toBe('true');
      expect(surface.classList.contains('bg-bg-elev')).toBe(true);
      expect(surface.classList.contains('pointer-events-none')).toBe(true);
      for (const el of [...layers, ...bars]) {
        expect(surface.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    }
    const frame = container.querySelector(`[data-pane-frame="${surfaces[0].getAttribute('data-pane-surface')}"]`) as HTMLElement;
    expect(surfaces[0].style.left).toBe(frame.style.left);
    expect(surfaces[0].style.top).toBe(frame.style.top);
    expect(surfaces[0].style.width).toBe(frame.style.width);
    expect(surfaces[0].style.height).toBe(frame.style.height);
  });

  it('pulls the pane area up by the frame inset so the cards touch the header', () => {
    const { container } = render(<PaneLayout />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.marginTop).toBe(`-${PANE_GAP / 2}px`);
  });

  it('marks only the focused pane frame when the layout is split', () => {
    const { container } = render(<PaneLayout />);
    expect(container.querySelectorAll('[data-pane-frame]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-pane-frame][data-focused="true"]')).toHaveLength(0);

    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });

    const focused = container.querySelectorAll('[data-pane-frame][data-focused="true"]');
    expect(focused).toHaveLength(1);
    expect(focused[0].getAttribute('data-pane-frame')).toBe(useStore.getState().focusedPaneId);
  });

  it('renders a resizer for each split boundary', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  it('keeps the pane resizer invisible in the gap until it is hovered', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    const handle = container.querySelector('[role="separator"]') as HTMLElement;
    expect(handle.classList.contains('bg-border')).toBe(false);
    expect(handle.classList.contains('bg-transparent')).toBe(true);
    expect(handle.classList.contains('hover:bg-accent')).toBe(true);
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
        x: left, y: 0, left, top: 0, right: left + width, bottom: PANE_BAR_HEIGHT,
        width, height: PANE_BAR_HEIGHT, toJSON: () => ({}),
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

  it('treats a drop inside the pane bar as a reorder, not a split', () => {
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    const tab = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(10, 45));
    fireEvent.pointerMove(window, pointerAt(500, 45));
    fireEvent.pointerUp(window, pointerAt(500, 45));

    expect(leaves(useStore.getState().layout)).toHaveLength(1);
  });

  it('clamps a vertical resize to leave room for the pane bar', () => {
    act(() => {
      useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'col', false, 't2');
    });
    const { container } = render(<PaneLayout />);
    stubBox(container.firstElementChild as HTMLElement, 1000, 800);
    const handle = container.querySelector('[role="separator"]') as HTMLElement;

    fireEvent.mouseDown(handle, { clientX: 500, clientY: 400 });
    fireEvent.mouseMove(window, { clientX: 500, clientY: 10 });

    const root = useStore.getState().layout as PaneSplit;
    expect(root.sizes[0]).toBeCloseTo((MIN_PANE_HEIGHT + PANE_BAR_HEIGHT) / 800);
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

  it('inserts a tab dropped on the bottom edge of the pane bar instead of splitting', () => {
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
    const barBottom = PANE_GAP / 2 + PANE_BORDER + PANE_BAR_HEIGHT;

    fireEvent.pointerDown(tab, pointerAt(50, 10));
    fireEvent.pointerMove(window, pointerAt(600, barBottom - 2));
    fireEvent.pointerUp(window, pointerAt(600, barBottom - 2));

    expect(leaves(useStore.getState().layout)).toHaveLength(1);
    expect(findLeaf(useStore.getState().layout, 'right')?.tabIds).toEqual(['t2', 't1', 't3']);
  });

  it('appends a tab dropped deep in a pane body, ignoring the horizontal position', () => {
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
    fireEvent.pointerMove(window, pointerAt(640, 400));
    fireEvent.pointerUp(window, pointerAt(640, 400));

    expect(findLeaf(useStore.getState().layout, 'right')?.tabIds).toEqual(['t2', 't3', 't1']);
  });

  it('maps a slot measured over the sessions of the selected project back onto the tab list', () => {
    act(() => {
      useStore.setState({
        tabs: [
          terminalTabIn('drag', 'Przenoszony', 3),
          terminalTabIn('g1', 'G1', 1),
          terminalTabIn('g2', 'G2', 1),
          terminalTabIn('solo', 'Solo', 2),
        ],
        activeTabId: 'drag',
        projects: [
          { id: 1, name: 'Grupa', path: '/g' },
          { id: 2, name: 'Pojedynczy', path: '/p' },
          { id: 3, name: 'Zrodlo', path: '/z' },
        ] as never,
        layout: {
          kind: 'split', id: 'outer', dir: 'row', sizes: [0.5, 0.5],
          children: [createLeaf('left', ['drag'], 'drag'), createLeaf('right', ['g1', 'solo', 'g2'], 'g1')],
        },
        focusedPaneId: 'left',
      });
    });
    const { container } = render(<PaneLayout />);
    expect(container.querySelectorAll('[data-pane-id="right"] [data-tab-id]')).toHaveLength(2);
    stubContainerBox(container);
    stubTabBoxes(container, 'right', 500, 100);
    const tab = container.querySelector('[data-tab-id="drag"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(50, 10));
    fireEvent.pointerMove(window, pointerAt(620, 10));
    fireEvent.pointerUp(window, pointerAt(620, 10));

    expect(findLeaf(useStore.getState().layout, 'right')?.tabIds).toEqual(['g1', 'solo', 'drag', 'g2']);
  });

  it('never starts a drag from a pointer press inside the rename input', () => {
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    const tab = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    fireEvent.doubleClick(tab.querySelector('span.truncate') as HTMLElement);
    const input = tab.querySelector('input') as HTMLInputElement;
    fireEvent.pointerDown(input, pointerAt(30, 10));
    fireEvent.pointerMove(window, pointerAt(960, 400));
    fireEvent.pointerUp(window, pointerAt(960, 400));

    expect(leaves(useStore.getState().layout)).toHaveLength(1);
    expect(findLeaf(useStore.getState().layout, ROOT_PANE_ID)?.tabIds).toEqual(['t1', 't2']);
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

describe('PaneLayout pane bar', () => {
  beforeEach(() => {
    useStore.setState({
      tabs: [terminalTab('t1', 'Lewy')],
      activeTabId: 't1',
      mruOrder: ['t1'],
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      layout: createLeaf(ROOT_PANE_ID, ['t1'], 't1'),
      focusedPaneId: ROOT_PANE_ID,
    });
  });

  it('renders the sessions-only bar and reserves its height', () => {
    const { container } = render(<PaneLayout />);
    expect(container.querySelector('[data-project-tab-id]')).toBeNull();
    expect(container.querySelector(`[data-pane-id="${ROOT_PANE_ID}"] [data-tab-id="t1"]`)).not.toBeNull();
    const layer = container.querySelector('[data-tab-layer="t1"]') as HTMLElement;
    expect(layer.style.top).toBe(`calc(0% + ${PANE_GAP / 2 + PANE_BORDER + PANE_BAR_HEIGHT}px)`);
  });
});

const liveSession = (id: string): Tab => ({ kind: 'session', id, projectId: 1, sessionId: id, title: id, mode: 'terminal' });

describe('PaneLayout terminal drawer', () => {
  beforeEach(() => {
    counters.terminalMounts = 0;
    useStore.setState({
      tabs: [liveSession('s1')],
      activeTabId: 's1',
      mruOrder: [],
      navHistory: [],
      navIndex: 0,
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      layout: createLeaf(ROOT_PANE_ID, ['s1'], 's1'),
      focusedPaneId: ROOT_PANE_ID,
      drawers: {},
      drawerTerminals: {},
      drawerDragSize: null,
      drawerClosePrompt: null,
      terminalDrawerSize: 0.35,
    });
  });

  const drawerIds = () => leaves(useStore.getState().drawers.s1.layout).map(l => l.id);

  it('shrinks the session layer and places the drawer terminal below it', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const [id] = drawerIds();
    const session = container.querySelector('[data-tab-layer="s1"]') as HTMLElement;
    const terminal = container.querySelector(`[data-tab-layer="${id}"]`) as HTMLElement;
    expect(session.style.height).toBe('calc(65% - 37.7px)');
    expect(terminal.style.top).toBe('calc(65% + 51.3px)');
    expect(terminal.dataset.drawerOwner).toBe('s1');
  });

  it('never remounts a drawer terminal when it is detached to a tab', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    expect(counters.terminalMounts).toBe(2);
    const [id] = drawerIds();
    const node = container.querySelector(`[data-tab-layer="${id}"]`) as HTMLElement;
    const observer = new MutationObserver(() => {});
    observer.observe(node.parentElement!, { childList: true });

    act(() => { useStore.getState().detachDrawerTerminal(id); });

    const removed = observer.takeRecords().flatMap(r => Array.from(r.removedNodes));
    observer.disconnect();
    expect(counters.terminalMounts).toBe(2);
    expect(container.querySelector(`[data-tab-layer="${id}"]`)).toBe(node);
    expect(removed).not.toContain(node);
    expect(node.dataset.drawerOwner).toBeUndefined();
  });

  it('never remounts drawer terminals when their session moves to another pane', () => {
    useStore.setState({ tabs: [liveSession('s1'), terminalTab('t2', 'Inny')], layout: createLeaf(ROOT_PANE_ID, ['s1', 't2'], 's1') });
    render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const mounts = counters.terminalMounts;
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 's1'); });
    expect(counters.terminalMounts).toBe(mounts);
  });

  it('keeps the terminals of a hidden drawer mounted but invisible', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const [id] = drawerIds();
    act(() => { useStore.getState().hideTerminalDrawer('s1'); });
    const layer = container.querySelector(`[data-tab-layer="${id}"]`) as HTMLElement;
    expect(layer.className).toContain('invisible');
    expect(counters.terminalMounts).toBe(2);
    expect((container.querySelector('[data-tab-layer="s1"]') as HTMLElement).style.height).toBe('calc(100% - 94px)');
  });

  it('leaves a restore bar under the session only while the drawer is hidden', () => {
    const { container } = render(<PaneLayout />);
    expect(container.querySelector('[data-drawer-collapsed]')).toBeNull();
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    expect(container.querySelector('[data-drawer-collapsed]')).toBeNull();

    act(() => { useStore.getState().hideTerminalDrawer('s1'); });

    const bar = container.querySelector('[data-drawer-collapsed="s1"]') as HTMLElement;
    expect(bar.style.top).toBe('calc(100% - 41px)');
    expect(bar.style.height).toBe('calc(0% + 36px)');
    expect(bar.textContent).toBe('Terminal');
  });

  it('shows the shell count on the restore bar of a split drawer', () => {
    const { container } = render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().splitDrawerTerminal('s1', 'row');
      useStore.getState().hideTerminalDrawer('s1');
    });
    expect((container.querySelector('[data-drawer-collapsed="s1"]') as HTMLElement).textContent).toBe('Terminal · 2');
  });

  it('restores the drawer and hands it the keyboard from the restore bar', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const [id] = drawerIds();
    act(() => { useStore.getState().hideTerminalDrawer('s1'); });

    fireEvent.click(screen.getByRole('button', { name: /Pokaż terminal/ }));

    expect(useStore.getState().drawers.s1).toMatchObject({ open: true, hasFocus: true });
    expect(container.querySelector('[data-drawer-collapsed]')).toBeNull();
    expect(container.querySelector('[data-drawer-header="s1"]')).not.toBeNull();
    const terminal = container.querySelector(`[data-tab-layer="${id}"] [data-testid="terminal"]`) as HTMLElement;
    expect(terminal.dataset.takeFocus).toBe('true');
    expect(counters.terminalMounts).toBe(2);
  });

  it('focuses the pane whose restore bar is clicked', () => {
    useStore.setState({ tabs: [liveSession('s1'), terminalTab('t2', 'Inny')], layout: createLeaf(ROOT_PANE_ID, ['s1', 't2'], 's1') });
    render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().hideTerminalDrawer('s1');
      useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2');
    });
    const paneOf = (tabId: string) => leaves(useStore.getState().layout).find(l => l.tabIds.includes(tabId))!.id;
    act(() => { useStore.getState().focusPane(paneOf('t2')); });
    expect(useStore.getState().focusedPaneId).toBe(paneOf('t2'));

    fireEvent.click(screen.getByRole('button', { name: /Pokaż terminal/ }));

    expect(useStore.getState().focusedPaneId).toBe(paneOf('s1'));
  });

  it('hands the keyboard back to the session when the last drawer shell exits', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const session = () => container.querySelector('[data-tab-layer="s1"] [data-testid="terminal"]') as HTMLElement;
    expect(session().dataset.takeFocus).toBe('false');

    fireEvent.click(container.querySelector('[data-testid="exit"]')!);

    expect(useStore.getState().drawers.s1).toBeUndefined();
    expect(session().dataset.takeFocus).toBe('true');
  });

  it('moves the keyboard between the session and a clicked drawer terminal', () => {
    const { container } = render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().splitDrawerTerminal('s1', 'row');
    });
    const [first] = drawerIds();
    fireEvent.mouseDown(container.querySelector(`[data-tab-layer="${first}"] [data-testid="terminal"]`)!);
    expect(useStore.getState().drawers.s1).toMatchObject({ hasFocus: true, focusedTerminalId: first });
    fireEvent.mouseDown(container.querySelector('[data-tab-layer="s1"] [data-testid="terminal"]')!);
    expect(useStore.getState().drawers.s1.hasFocus).toBe(false);
  });

  it('splits from the header and outlines the focused terminal', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    expect(container.querySelector('[data-drawer-focus-ring]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Podziel w prawo/ }));
    expect(container.querySelectorAll('[data-drawer-owner="s1"]')).toHaveLength(2);
    expect(container.querySelector('[data-drawer-focus-ring]')).not.toBeNull();
  });

  it('shows one pressed chip per drawer shell named after the configured shell', () => {
    useStore.setState({ shellPath: '/usr/bin/zsh' });
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    expect(screen.getAllByRole('button', { name: 'zsh' }).map(b => b.getAttribute('aria-pressed'))).toEqual(['true']);
    act(() => { useStore.getState().splitDrawerTerminal('s1', 'row'); });
    const [first, second] = drawerIds();
    const chips = screen.getAllByRole('button', { name: 'zsh' });
    expect(chips.map(b => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(container.querySelector('[data-drawer-header="s1"]')!.contains(chips[0])).toBe(true);

    fireEvent.click(chips[0]);

    expect(useStore.getState().drawers.s1.focusedTerminalId).toBe(first);
    expect(second).not.toBe(first);
    useStore.setState({ shellPath: '' });
  });

  it('labels the chip Terminal while the shell is on auto', () => {
    useStore.setState({ shellPath: '' });
    render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    expect(screen.getByRole('button', { name: 'Terminal' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('leaves the terminal surface to the terminal for both the live session and the drawer shell', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const [id] = drawerIds();
    for (const layerId of ['s1', id]) {
      const className = container.querySelector(`[data-tab-layer="${layerId}"] > div`)!.className;
      expect(className).not.toMatch(/\bbg-(console|sunken)\b/);
    }
  });

  it('rounds the focus ring corners that meet the card bottom', () => {
    const { container } = render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().splitDrawerTerminal('s1', 'row');
    });
    const ring = container.querySelector('[data-drawer-focus-ring]') as HTMLElement;
    expect(ring.style.borderBottomRightRadius).toBe('11px');
    expect(ring.style.borderBottomLeftRadius).toBe('');
    act(() => { useStore.getState().focusDrawerTerminal('s1', drawerIds()[0]); });
    const left = container.querySelector('[data-drawer-focus-ring]') as HTMLElement;
    expect(left.style.borderBottomLeftRadius).toBe('11px');
    expect(left.style.borderBottomRightRadius).toBe('');
  });

  it('detaches the focused terminal from the header', () => {
    render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const [id] = drawerIds();
    fireEvent.click(screen.getByRole('button', { name: 'Wydziel do zakładki' }));
    expect(useStore.getState().tabs.some(t => t.id === id && t.kind === 'terminal')).toBe(true);
    expect(useStore.getState().drawers).toEqual({});
  });

  it('hides the drawer from the header', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    fireEvent.click(screen.getByRole('button', { name: 'Schowaj panel' }));
    expect(useStore.getState().drawers.s1.open).toBe(false);
    expect(container.querySelector('[data-drawer-header]')).toBeNull();
  });

  it('asks before closing a terminal from the header', () => {
    render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    fireEvent.click(screen.getByRole('button', { name: 'Zamknij terminal' }));
    expect(screen.getByText('Zamknąć terminal?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zamknij' }));
    expect(useStore.getState().drawers).toEqual({});
    expect(screen.queryByText('Zamknąć terminal?')).toBeNull();
  });

  it('resizes the drawer from the divider and persists only on release', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    stubBox(container.firstElementChild as HTMLElement, 1000, 800);
    const divider = container.querySelector('[data-drawer-divider]') as HTMLElement;

    const contentPx = 800 - PANE_GAP - 2 * PANE_BORDER - PANE_BAR_HEIGHT;

    fireEvent.mouseDown(divider, { clientX: 500, clientY: 500 });
    fireEvent.mouseMove(window, { clientX: 500, clientY: 400 });
    expect(useStore.getState().drawerDragSize).toBeCloseTo(0.35 + 100 / contentPx);
    expect(useStore.getState().terminalDrawerSize).toBe(0.35);

    fireEvent.mouseUp(window);
    expect(useStore.getState().terminalDrawerSize).toBeCloseTo(0.35 + 100 / contentPx);
    expect(useStore.getState().drawerDragSize).toBeNull();
  });

  it('resizes a split inside the drawer', () => {
    const { container } = render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().splitDrawerTerminal('s1', 'row');
    });
    stubBox(container.firstElementChild as HTMLElement, 1000, 800);
    const handle = container.querySelector('[role="separator"]:not([data-drawer-divider])') as HTMLElement;
    fireEvent.mouseDown(handle, { clientX: 500, clientY: 700 });
    fireEvent.mouseMove(window, { clientX: 600, clientY: 700 });
    const split = useStore.getState().drawers.s1.layout as PaneSplit;
    expect(split.sizes[0]).toBeCloseTo(0.6);
    expect(handle.classList.contains('bg-border')).toBe(true);
  });

  it('drops the focus ring when another pane takes focus', () => {
    useStore.setState({ tabs: [liveSession('s1'), terminalTab('t2', 'Inny')], layout: createLeaf(ROOT_PANE_ID, ['s1', 't2'], 's1') });
    const { container } = render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().splitDrawerTerminal('s1', 'row');
      useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2');
      useStore.getState().focusPane(ROOT_PANE_ID);
    });
    expect(container.querySelector('[data-drawer-focus-ring]')).not.toBeNull();
    const otherPane = leaves(useStore.getState().layout).find(l => l.tabIds.includes('t2'))!;
    act(() => { useStore.getState().focusPane(otherPane.id); });
    expect(container.querySelector('[data-drawer-focus-ring]')).toBeNull();
  });

  it('drops the focus ring when the keyboard returns to the session', () => {
    const { container } = render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().splitDrawerTerminal('s1', 'row');
    });
    expect(container.querySelector('[data-drawer-focus-ring]')).not.toBeNull();
    act(() => { useStore.getState().focusDrawerSession('s1'); });
    expect(container.querySelector('[data-drawer-focus-ring]')).toBeNull();
  });

  it('keeps DOM focus in the terminal when a header button is pressed', () => {
    render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    act(() => { useStore.getState().focusDrawerSession('s1'); });
    const button = screen.getByRole('button', { name: 'Wydziel do zakładki' });
    const ev = createEvent.mouseDown(button);
    fireEvent(button, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(useStore.getState().drawers.s1.hasFocus).toBe(true);
  });

  it('splits the focused drawer terminal with the shortcut', () => {
    render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    fireEvent.keyDown(document, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(drawerIds()).toHaveLength(2);
  });

  it('lets split shortcuts through to the session while it holds the keyboard', () => {
    render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().focusDrawerSession('s1');
    });
    const ev = createEvent.keyDown(document, { key: 'O', ctrlKey: true, shiftKey: true });
    fireEvent(document, ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(drawerIds()).toHaveLength(1);
  });

  it('moves between drawer splits with mod+alt+arrows', () => {
    render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().splitDrawerTerminal('s1', 'row');
    });
    const [first] = drawerIds();
    fireEvent.keyDown(document, { key: 'ArrowLeft', ctrlKey: true, altKey: true });
    expect(useStore.getState().drawers.s1.focusedTerminalId).toBe(first);
  });

  it('closes the focused drawer terminal on mod+w instead of the session', () => {
    render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const [id] = drawerIds();
    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });
    expect(useStore.getState().drawerClosePrompt).toBe(id);
    expect(screen.getByText('Zamknąć terminal?')).toBeInTheDocument();
    expect(useStore.getState().tabs.some(t => t.id === 's1')).toBe(true);
  });

  it('closes the session on mod+w while the session holds the keyboard', () => {
    render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().focusDrawerSession('s1');
    });
    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });
    expect(useStore.getState().drawerClosePrompt).toBeNull();
    expect(screen.getByText('Zamknąć aktywny tab?')).toBeInTheDocument();
  });

  it('asks before closing a history session with a hidden drawer', () => {
    useStore.setState({ tabs: [{ kind: 'session', id: 's1', projectId: 1, sessionId: 's1', title: 's1', mode: 'history' }] });
    render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().hideTerminalDrawer('s1');
    });
    fireEvent.click(screen.getByTitle('Zamknij tab'));
    expect(screen.getByText('Zamknąć aktywny tab?')).toBeInTheDocument();
    expect(screen.getByText(/terminale z panelu \(1\)/)).toBeInTheDocument();
  });
});
