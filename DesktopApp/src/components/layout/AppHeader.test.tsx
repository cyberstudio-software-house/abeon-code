import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useStore } from '../../store';
import { createLeaf } from '../../lib/paneTree';
import { ROOT_PANE_ID } from '../../store/panesSlice';
import type { Tab } from '../../store/tabsSlice';
import { AppHeader } from './AppHeader';

const projects = [
  { id: 1, name: 'Alfa', path: '/a' },
  { id: 2, name: 'Beta', path: '/b' },
];

function seed(tabs: Tab[]) {
  useStore.setState({
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    mruOrder: [],
    runningActions: {},
    drawers: {},
    drawerTerminals: {},
    projects: projects as never,
    layout: createLeaf(ROOT_PANE_ID, tabs.map(t => t.id), tabs[0]?.id ?? null),
    focusedPaneId: ROOT_PANE_ID,
    settingsOpen: false,
    settingsCategory: 'general',
  });
}

const liveSession: Tab = { kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S1', mode: 'terminal' };
const historySession: Tab = { kind: 'session', id: 'session:s2', projectId: 2, sessionId: 's2', title: 'S2', mode: 'history' };
const shell: Tab = { kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' };

describe('AppHeader', () => {
  beforeEach(() => { seed([]); });

  it('renders the logo, the groups row and the active session count in the main variant', () => {
    seed([liveSession, shell, historySession]);
    const { container } = render(<AppHeader variant={{ kind: 'main' }} />);
    expect(screen.getByText('AbeonCode')).toBeInTheDocument();
    expect([...container.querySelectorAll('[data-project-tab-id]')].map(el => el.getAttribute('data-project-tab-id')))
      .toEqual(['1', '2']);
    expect(screen.getByText('2 aktywne sesje')).toBeInTheDocument();
  });

  it('sizes the logo block from the sidebar width so the project row starts above the centre column', () => {
    useStore.setState({ leftWidth: 320 });
    render(<AppHeader variant={{ kind: 'main' }} />);
    const block = screen.getByText('AbeonCode').parentElement as HTMLElement;
    expect(block.style.width).toBe('292px');
    act(() => { useStore.setState({ leftWidth: 200 }); });
    expect(block.style.width).toBe('172px');
  });

  it('counts drawer shells as active sessions', () => {
    seed([liveSession]);
    act(() => {
      useStore.getState().toggleTerminalDrawer('session:s1');
      useStore.getState().splitDrawerTerminal('session:s1', 'row');
    });
    render(<AppHeader variant={{ kind: 'main' }} />);
    expect(screen.getByText('3 aktywne sesje')).toBeInTheDocument();
  });

  it('hides the count when nothing runs', () => {
    seed([historySession]);
    render(<AppHeader variant={{ kind: 'main' }} />);
    expect(screen.queryByText(/aktywne/)).toBeNull();
  });

  it('renders the project name and Okno projektu in the project variant', () => {
    seed([liveSession]);
    const { container } = render(<AppHeader variant={{ kind: 'project', projectId: 1 }} />);
    expect(screen.getByText('Alfa')).toBeInTheDocument();
    expect(screen.getByText('Okno projektu')).toBeInTheDocument();
    expect(screen.getByText('1 aktywne')).toBeInTheDocument();
    expect(container.querySelector('[data-project-tab-id]')).toBeNull();
    expect(screen.queryByText('AbeonCode')).toBeNull();
  });

  it('renders the groups row in the session variant', () => {
    seed([liveSession]);
    const { container } = render(<AppHeader variant={{ kind: 'session' }} />);
    expect(container.querySelector('[data-project-tab-id="1"]')).not.toBeNull();
    expect(screen.getByText('1 aktywne')).toBeInTheDocument();
    expect(screen.queryByText('Okno projektu')).toBeNull();
  });

  it('shows the settings breadcrumb instead of the groups row only in the main variant', () => {
    seed([liveSession]);
    act(() => { useStore.setState({ settingsOpen: true, settingsCategory: 'models' }); });
    const main = render(<AppHeader variant={{ kind: 'main' }} />);
    expect(screen.getByRole('navigation', { name: 'Ścieżka' })).toHaveTextContent(/^Ustawienia\s*\/\s*Modele$/);
    expect(main.container.querySelector('[data-project-tab-id]')).toBeNull();
    main.unmount();

    const session = render(<AppHeader variant={{ kind: 'session' }} />);
    expect(session.container.querySelector('[data-project-tab-id="1"]')).not.toBeNull();
    expect(screen.queryByText('Ustawienia')).toBeNull();
  });

  it('marks the header as the window drag region', () => {
    const { container } = render(<AppHeader variant={{ kind: 'main' }} />);
    const header = container.querySelector('header') as HTMLElement;
    expect(header.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(header.style.paddingLeft).toBe('16px');
  });
});
