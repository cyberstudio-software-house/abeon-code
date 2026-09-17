import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useStore } from '../../store';
import { ProviderPicker } from './ProviderPicker';

const PICKER_ID = 'picker:p1';

function pickerRoot(container: HTMLElement) {
  return container.firstElementChild as HTMLElement;
}

describe('ProviderPicker keyboard selection', () => {
  beforeEach(() => {
    useStore.setState({
      enabledProviders: ['claude', 'codex', 'opencode'],
      tabs: [{ kind: 'providerPicker', id: PICKER_ID, projectId: 1, title: 'New session' }],
      activeTabId: PICKER_ID,
      mruOrder: [PICKER_ID],
      navHistory: [PICKER_ID],
    });
  });

  it('picks the provider matching the pressed digit', () => {
    const { container } = render(<ProviderPicker tabId={PICKER_ID} active />);
    fireEvent.keyDown(pickerRoot(container), { key: '2' });
    const tab = useStore.getState().tabs[0];
    if (tab.kind !== 'session') throw new Error('expected session tab');
    expect(tab.provider).toBe('codex');
  });

  it('ignores digits beyond the enabled providers', () => {
    const { container } = render(<ProviderPicker tabId={PICKER_ID} active />);
    fireEvent.keyDown(pickerRoot(container), { key: '4' });
    fireEvent.keyDown(pickerRoot(container), { key: '0' });
    expect(useStore.getState().tabs[0].kind).toBe('providerPicker');
  });

  it('leaves modified digits to global shortcuts', () => {
    const { container } = render(<ProviderPicker tabId={PICKER_ID} active />);
    fireEvent.keyDown(pickerRoot(container), { key: '1', ctrlKey: true });
    fireEvent.keyDown(pickerRoot(container), { key: '1', metaKey: true });
    fireEvent.keyDown(pickerRoot(container), { key: '1', altKey: true });
    expect(useStore.getState().tabs[0].kind).toBe('providerPicker');
  });

  it('shows the digit hint on every provider button', () => {
    const { getAllByRole } = render(<ProviderPicker tabId={PICKER_ID} active />);
    expect(getAllByRole('button').map(b => b.textContent)).toEqual(['1Claude Code', '2Codex', '3OpenCode']);
  });

  it('takes focus only while active', () => {
    const { container, rerender } = render(<ProviderPicker tabId={PICKER_ID} active={false} />);
    expect(document.activeElement).not.toBe(pickerRoot(container));
    rerender(<ProviderPicker tabId={PICKER_ID} active />);
    expect(document.activeElement).toBe(pickerRoot(container));
  });
});
