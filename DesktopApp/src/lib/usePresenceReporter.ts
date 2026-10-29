import { useEffect } from 'react';
import { useStore, type AppState } from '../store';
import { tauri } from './tauri';

export const PRESENCE_THROTTLE_MS = 20_000;
export const LEAVE_SESSION_DEBOUNCE_MS = 300;

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
    let leaveTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelLeave = () => {
      if (leaveTimer === null) return;
      clearTimeout(leaveTimer);
      leaveTimer = null;
    };

    const send = (sessionId: string | null) => {
      lastSentAt = Date.now();
      tauri.supervisorReportActivity(sessionId).catch(() => {});
    };

    const onActivity = () => {
      if (Date.now() - lastSentAt < PRESENCE_THROTTLE_MS) return;
      send(document.hasFocus() ? focusedSessionOf(useStore.getState()) : null);
    };

    const onBlur = () => {
      cancelLeave();
      send(null);
      lastSentAt = 0;
    };

    const unsubscribe = useStore.subscribe((state) => {
      const session = focusedSessionOf(state);
      if (session === trackedSession) return;
      trackedSession = session;
      cancelLeave();
      if (session === null) {
        leaveTimer = setTimeout(() => {
          leaveTimer = null;
          send(null);
        }, LEAVE_SESSION_DEBOUNCE_MS);
        return;
      }
      if (document.hasFocus()) send(session);
    });

    if (document.hasFocus()) send(trackedSession);

    window.addEventListener('focus', onActivity);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onActivity, true);
    window.addEventListener('mousedown', onActivity, true);
    return () => {
      unsubscribe();
      cancelLeave();
      window.removeEventListener('focus', onActivity);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onActivity, true);
      window.removeEventListener('mousedown', onActivity, true);
    };
  }, []);
}
