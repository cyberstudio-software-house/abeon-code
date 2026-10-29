import { useEffect } from 'react';
import { useStore, type AppState } from '../store';
import { tauri } from './tauri';

export const PRESENCE_THROTTLE_MS = 20_000;

export function focusedSessionOf(state: Pick<AppState, 'tabs' | 'activeAgentPtyId'>): string | null {
  const ptyId = state.activeAgentPtyId;
  if (!ptyId) return null;
  for (const tab of state.tabs) {
    if (tab.kind === 'session' && tab.ptyId === ptyId) return tab.linkedSessionId ?? tab.sessionId;
  }
  return null;
}

export function usePresenceReporter() {
  useEffect(() => {
    let lastSentAt = 0;
    let trackedSession = focusedSessionOf(useStore.getState());

    const send = (sessionId: string | null) => {
      lastSentAt = Date.now();
      tauri.supervisorReportActivity(sessionId).catch(() => {});
    };

    const onActivity = () => {
      if (Date.now() - lastSentAt < PRESENCE_THROTTLE_MS) return;
      send(document.hasFocus() ? focusedSessionOf(useStore.getState()) : null);
    };

    const unsubscribe = useStore.subscribe((state) => {
      const session = focusedSessionOf(state);
      if (session === trackedSession) return;
      trackedSession = session;
      if (session !== null && document.hasFocus()) send(session);
    });

    window.addEventListener('focus', onActivity);
    window.addEventListener('keydown', onActivity, true);
    window.addEventListener('mousedown', onActivity, true);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', onActivity);
      window.removeEventListener('keydown', onActivity, true);
      window.removeEventListener('mousedown', onActivity, true);
    };
  }, []);
}
