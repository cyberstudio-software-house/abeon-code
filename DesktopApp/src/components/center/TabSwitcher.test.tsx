import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { TabSwitcher } from './TabSwitcher';
import { useStore } from '../../store';

const term = (id: string) => ({ kind: 'terminal' as const, id, projectId: 1, title: id });

describe('TabSwitcher', () => {
  beforeEach(() => {
    useStore.setState({
      projects: [{ id: 1, name: 'Proj', path: '/p', color: '#fff' }],
      tabs: [term('t1'), term('t2')],
      activeTabId: 't2',
      mruOrder: ['t2', 't1'],
      settingsOpen: false,
    } as never);
  });

  it('commits the selected tab on Ctrl release', () => {
    render(<TabSwitcher />);
    act(() => { fireEvent.keyDown(document, { key: 'Tab', ctrlKey: true }); });
    expect(screen.getByText('Przełącz zakładkę')).toBeInTheDocument();
    act(() => { fireEvent.keyUp(document, { key: 'Control' }); });
    expect(useStore.getState().activeTabId).toBe('t1');
  });

  it('closes without committing when settings open while the switcher is open', () => {
    render(<TabSwitcher />);
    act(() => { fireEvent.keyDown(document, { key: 'Tab', ctrlKey: true }); });
    expect(screen.getByText('Przełącz zakładkę')).toBeInTheDocument();
    act(() => { useStore.getState().openSettings(); });
    act(() => { fireEvent.keyUp(document, { key: 'Control' }); });
    expect(useStore.getState().activeTabId).toBe('t2');
    expect(screen.queryByText('Przełącz zakładkę')).toBeNull();
  });
});
