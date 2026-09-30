import { useEffect } from 'react';
import { useStore } from '../../store';
import { drawerFocusDirection, matchesShortcut } from '../../lib/shortcuts';

export function useTerminalDrawerShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = useStore.getState();
      const tabId = state.activeTabId;
      const drawer = tabId ? state.drawers[tabId] : undefined;
      if (!tabId || !drawer?.open || !drawer.hasFocus) return;
      const overrides = state.shortcutOverrides;
      const direction = drawerFocusDirection(e);
      if (matchesShortcut(e, 'splitTerminalRight', overrides)) state.splitDrawerTerminal(tabId, 'row');
      else if (matchesShortcut(e, 'splitTerminalDown', overrides)) state.splitDrawerTerminal(tabId, 'col');
      else if (direction) state.moveDrawerFocus(tabId, direction);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);
}
