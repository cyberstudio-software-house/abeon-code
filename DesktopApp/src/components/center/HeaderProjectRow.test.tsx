import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../lib/processManager', () => ({ processManager: { dismiss: vi.fn(), release: vi.fn() } }));
vi.mock('../../lib/detachGroup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/detachGroup')>();
  return {
    ...actual,
    detachProjectGroup: vi.fn(),
    focusExistingGroupWindow: vi.fn().mockResolvedValue(false),
  };
});

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

Element.prototype.scrollIntoView = vi.fn();

import { detachProjectGroup, focusExistingGroupWindow } from '../../lib/detachGroup';
import { useStore } from '../../store';
import { HeaderProjectRow } from './HeaderProjectRow';
import { PaneBar } from './PaneBar';
import { createLeaf, findLeaf, insertBeside } from '../../lib/paneTree';
import { pickProjectTab } from '../../lib/tabGrouping';
import { ROOT_PANE_ID } from '../../store/panesSlice';
import type { Tab } from '../../store/tabsSlice';

const projects = [
  { id: 1, name: 'Alfa', path: '/a' },
  { id: 2, name: 'Beta', path: '/b' },
  { id: 3, name: 'Gamma', path: '/g' },
];

const history = (id: string, projectId: number): Tab =>
  ({ kind: 'session', id, projectId, sessionId: id, title: id.toUpperCase(), mode: 'history' });

const twoPaneLayout = (leftTabs: string[], leftActive: string, rightTabs: string[], rightActive: string) =>
  insertBeside(
    createLeaf(ROOT_PANE_ID, leftTabs, leftActive),
    ROOT_PANE_ID, 'row', false,
    createLeaf('p2', rightTabs, rightActive),
    's1',
  );

function seedTwoPanes(mruOrder: string[] = ['a1']) {
  useStore.setState({
    tabs: [history('a1', 1), history('b1', 2), history('b2', 2), history('c1', 3)],
    activeTabId: 'a1',
    mruOrder,
    navHistory: ['a1'],
    navIndex: 0,
    runningActions: {},
    drawers: {},
    drawerTerminals: {},
    projects: projects as never,
    layout: twoPaneLayout(['a1', 'b1', 'b2'], 'a1', ['c1'], 'c1'),
    focusedPaneId: ROOT_PANE_ID,
  });
}

const chipIds = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-project-tab-id]')].map(el => el.getAttribute('data-project-tab-id'));

describe('HeaderProjectRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(focusExistingGroupWindow).mockResolvedValue(false);
  });

  it('shows the project groups of the focused pane only', () => {
    seedTwoPanes();
    const { container } = render(<HeaderProjectRow />);
    expect(screen.getByText('Alfa')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Gamma')).toBeNull();
    expect(chipIds(container)).toEqual(['1', '2']);

    act(() => { useStore.getState().focusPane('p2'); });

    expect(screen.queryByText('Alfa')).toBeNull();
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
  });

  it('marks the project of the focused pane active tab as selected', () => {
    seedTwoPanes();
    const { container } = render(<HeaderProjectRow />);
    const selected = container.querySelector('[data-project-tab-id="1"]') as HTMLElement;
    const other = container.querySelector('[data-project-tab-id="2"]') as HTMLElement;
    expect(selected.getAttribute('aria-current')).toBe('page');
    expect(selected.classList.contains('bg-bg-elev-2')).toBe(true);
    expect(other.hasAttribute('aria-current')).toBe(false);
    expect(other.textContent).toBe('Beta2');
  });

  it('selects the project in the focused pane', () => {
    seedTwoPanes(['b2', 'a1']);
    render(<HeaderProjectRow />);
    fireEvent.click(screen.getByText('Beta'));

    const state = useStore.getState();
    const leaf = findLeaf(state.layout, state.focusedPaneId);
    const paneTabs = state.tabs.filter(t => leaf?.tabIds.includes(t.id));
    expect(state.focusedPaneId).toBe(ROOT_PANE_ID);
    expect(leaf?.activeTabId).toBe(pickProjectTab(paneTabs, state.mruOrder, 2));
    expect(leaf?.activeTabId).toBe('b2');
  });

  it('falls back to the first tab of the project when none was ever active', () => {
    seedTwoPanes(['a1']);
    render(<HeaderProjectRow />);
    fireEvent.click(screen.getByText('Beta'));
    expect(useStore.getState().activeTabId).toBe('b1');
  });

  it('opens the group menu with "Wydziel do nowego okna" on right click', () => {
    seedTwoPanes();
    const { container } = render(<HeaderProjectRow />);
    fireEvent.contextMenu(container.querySelector('[data-project-tab-id="2"]') as HTMLElement);
    expect(screen.getByText('Wydziel do nowego okna')).toBeInTheDocument();
  });

  it('detaches the project group from the project row context menu', async () => {
    seedTwoPanes();
    const { container } = render(<HeaderProjectRow />);
    fireEvent.contextMenu(container.querySelector('[data-project-tab-id="2"]') as HTMLElement);
    fireEvent.click(screen.getByText('Wydziel do nowego okna'));
    await waitFor(() => expect(detachProjectGroup).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 2, projectName: 'Beta' }),
    ));
    expect(vi.mocked(detachProjectGroup).mock.calls[0][0].tabs.map(t => t.id)).toEqual(['b1', 'b2']);
  });

  it('closes exactly one tab on mod+w with the header row mounted', () => {
    seedTwoPanes();
    render(<><HeaderProjectRow /><PaneBar paneId={ROOT_PANE_ID} /><PaneBar paneId="p2" /></>);

    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });

    expect(useStore.getState().tabs.map(t => t.id)).toEqual(['b1', 'b2', 'c1']);
    expect(screen.queryByText('Zamknąć aktywny tab?')).toBeNull();
  });

  it('opens exactly one close dialog on mod+w for a live terminal with the header row mounted', () => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 't1', projectId: 1, title: 'Lewy' }, history('c1', 3)],
      activeTabId: 't1',
      mruOrder: ['t1'],
      navHistory: ['t1'],
      navIndex: 0,
      runningActions: {},
      drawers: {},
      drawerTerminals: {},
      projects: projects as never,
      layout: twoPaneLayout(['t1'], 't1', ['c1'], 'c1'),
      focusedPaneId: ROOT_PANE_ID,
    });
    render(<><HeaderProjectRow /><PaneBar paneId={ROOT_PANE_ID} /><PaneBar paneId="p2" /></>);

    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });

    expect(screen.getAllByText('Zamknąć aktywny tab?')).toHaveLength(1);
    expect(useStore.getState().tabs).toHaveLength(2);
  });
});
