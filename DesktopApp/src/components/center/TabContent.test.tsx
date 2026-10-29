import { useEffect } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { Tab } from '../../store/tabsSlice';

const counters = vi.hoisted(() => ({ terminalMounts: 0, lastProps: null as Record<string, unknown> | null }));

vi.mock('../terminal/TerminalView', () => ({
  TerminalView: (props: { visible?: boolean }) => {
    counters.lastProps = props;
    useEffect(() => { counters.terminalMounts += 1; }, []);
    return <div data-testid="terminal" data-visible={String(props.visible)} />;
  },
}));
vi.mock('../history/HistoryView', () => ({
  HistoryView: () => <div data-testid="history" />,
}));
vi.mock('../history/SubagentView', () => ({
  SubagentView: () => <div data-testid="subagent" />,
}));

import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { TabPanel } from './TabContent';

// Stands in for the layer stack PaneLayout renders: every tab mounted at once,
// only the pane's active one visible.
function TabPanels() {
  const tabs = useStore(useShallow(s => s.tabs));
  const active = useStore(s => s.activeTabId);
  return (
    <div className="relative">
      {tabs.map(t => <TabPanel key={t.id} tab={t} visible={t.id === active} />)}
    </div>
  );
}

const sessionTab: Extract<Tab, { kind: 'session' }> = {
  kind: 'session',
  id: 'session:s1',
  projectId: 1,
  sessionId: 's1',
  title: 'Sesja',
  mode: 'terminal',
};

describe('TabPanel and the subagent view', () => {
  beforeEach(() => {
    counters.terminalMounts = 0;
    useStore.setState({ tabs: [], activeTabId: null, mruOrder: [] });
  });

  it('keeps TerminalView mounted while the subagent is shown', () => {
    useStore.setState({ tabs: [sessionTab], activeTabId: 'session:s1' });
    const { getByTestId } = render(<TabPanels />);
    expect(getByTestId('terminal')).toBeTruthy();

    act(() => { useStore.setState({ tabs: [{ ...sessionTab, viewingSubagentId: 'a1' }] }); });

    expect(getByTestId('subagent')).toBeTruthy();
    expect(getByTestId('terminal')).toBeTruthy();
  });

  it('never remounts TerminalView when the subagent view opens and closes', () => {
    useStore.setState({ tabs: [sessionTab], activeTabId: 'session:s1' });
    render(<TabPanels />);
    expect(counters.terminalMounts).toBe(1);

    act(() => { useStore.getState().viewSubagent('session:s1', 'a1'); });
    expect(counters.terminalMounts).toBe(1);

    act(() => { useStore.getState().viewSubagent('session:s1', null); });
    expect(counters.terminalMounts).toBe(1);
  });

  it('hides the live view from the user while the subagent covers it', () => {
    useStore.setState({ tabs: [sessionTab], activeTabId: 'session:s1' });
    const { getByTestId, queryByTestId } = render(<TabPanels />);
    expect(getByTestId('terminal').dataset.visible).toBe('true');

    act(() => { useStore.getState().viewSubagent('session:s1', 'a1'); });
    expect(getByTestId('terminal').dataset.visible).toBe('false');

    act(() => { useStore.getState().viewSubagent('session:s1', null); });
    expect(getByTestId('terminal').dataset.visible).toBe('true');
    expect(queryByTestId('subagent')).toBeNull();
  });

  it('keeps HistoryView mounted when the tab is in history mode', () => {
    useStore.setState({
      tabs: [{ ...sessionTab, mode: 'history', viewingSubagentId: 'a1' }],
      activeTabId: 'session:s1',
    });
    const { getByTestId } = render(<TabPanels />);
    expect(getByTestId('history')).toBeTruthy();
    expect(getByTestId('subagent')).toBeTruthy();
  });

  it('hides the subagent overlay of an inactive tab', () => {
    useStore.setState({
      tabs: [
        { ...sessionTab, viewingSubagentId: 'a1' },
        { kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' },
      ],
      activeTabId: 'terminal:t1',
    });
    const { getByTestId, getAllByTestId } = render(<TabPanels />);
    const overlay = getByTestId('subagent').parentElement;
    expect(overlay?.className).toContain('invisible');
    expect(overlay?.className).toContain('pointer-events-none');
    expect(getAllByTestId('terminal')[0].dataset.visible).toBe('false');
  });
});

describe('TabPanel keyboard and exit wiring', () => {
  it('passes takeFocus and onExit to a terminal tab', () => {
    const onExit = vi.fn();
    render(<TabPanel tab={{ kind: 'terminal', id: 't1', projectId: 1, title: 'T' }} visible focused takeFocus={false} onExit={onExit} />);
    expect(counters.lastProps).toMatchObject({ kind: 'shell', focused: true, takeFocus: false, onExit });
  });

  it('passes takeFocus to a live session', () => {
    render(<TabPanel tab={{ kind: 'session', id: 's', projectId: 1, sessionId: 's', title: 'S', mode: 'terminal' }} visible focused takeFocus={false} />);
    expect(counters.lastProps).toMatchObject({ kind: 'agent', focused: true, takeFocus: false });
  });
});

describe('TabPanel question card', () => {
  const baseSnapshot = {
    level: 'assistant' as const, running: true, ready: true, ptyId: 'p1', present: true, away: false,
    escalations: [], approvals: [],
  };
  const card = (sessionId: string) => ({
    questionId: 'q1',
    sessionId,
    questions: [{ question: 'Which color?', header: null, options: ['Red'], multiSelect: false }],
    phase: 'paused' as const,
    deadlineMs: null,
  });

  beforeEach(() => {
    counters.terminalMounts = 0;
    useStore.setState({ tabs: [], activeTabId: null, mruOrder: [], supervisor: null });
  });

  it('shows the card of the tab session without remounting the terminal', () => {
    useStore.setState({ tabs: [sessionTab], activeTabId: 'session:s1' });
    const { getByTestId, queryByText } = render(<TabPanels />);
    const terminal = getByTestId('terminal');
    expect(queryByText('Which color?')).toBeNull();

    act(() => { useStore.setState({ supervisor: { ...baseSnapshot, cards: [card('s1')] } }); });
    expect(queryByText('Which color?')).toBeTruthy();
    expect(getByTestId('terminal')).toBe(terminal);

    act(() => { useStore.setState({ supervisor: { ...baseSnapshot, cards: [] } }); });
    expect(queryByText('Which color?')).toBeNull();
    expect(getByTestId('terminal')).toBe(terminal);
    expect(counters.terminalMounts).toBe(1);
  });

  it('matches on the linked session id', () => {
    useStore.setState({
      tabs: [{ ...sessionTab, sessionId: 'new-1', linkedSessionId: 's9' }],
      activeTabId: 'session:s1',
      supervisor: { ...baseSnapshot, cards: [card('s9')] },
    });
    const { queryByText } = render(<TabPanels />);
    expect(queryByText('Which color?')).toBeTruthy();
  });

  it('ignores cards of other sessions', () => {
    useStore.setState({
      tabs: [sessionTab],
      activeTabId: 'session:s1',
      supervisor: { ...baseSnapshot, cards: [card('other')] },
    });
    const { queryByText } = render(<TabPanels />);
    expect(queryByText('Which color?')).toBeNull();
  });

  it('hides the card of an inactive tab', () => {
    useStore.setState({
      tabs: [sessionTab, { kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' }],
      activeTabId: 'terminal:t1',
      supervisor: { ...baseSnapshot, cards: [card('s1')] },
    });
    const { getByRole } = render(<TabPanels />);
    expect(getByRole('group', { hidden: true }).className).toContain('invisible');
  });
});
