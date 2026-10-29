import { useEffect } from 'react';
import { useStore } from '../store';
import { tauri } from './tauri';
import { supervisorProcess } from './supervisorProcess';
import type { SessionRebound, SupervisorSnapshot } from '../types';

export function followSessionRebound({ ptyId, sessionId }: SessionRebound) {
  const { tabs, linkNewSession } = useStore.getState();
  const tab = tabs.find(t => t.kind === 'session' && t.ptyId === ptyId);
  if (tab?.kind !== 'session' || (tab.linkedSessionId ?? tab.sessionId) === sessionId) return;
  linkNewSession(tab.id, sessionId);
}

export function useSupervisorSnapshot() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const start = async () => {
      try {
        const fn = await tauri.onSupervisorSessionRebound(followSessionRebound);
        if (disposed) fn();
        else unlisten = fn;
      } catch (error) {
        console.error('[supervisor] session rebound listener failed', error);
      }
    };
    void start();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let receivedEvent = false;
    let unlisten: (() => void) | null = null;
    const setSnapshot = useStore.getState().setSupervisorSnapshot;
    const apply = (snapshot: SupervisorSnapshot) => {
      if (snapshot.ptyId) supervisorProcess.track(snapshot.ptyId);
      setSnapshot(snapshot);
    };

    const start = async () => {
      try {
        const fn = await tauri.onSupervisorSnapshot((snapshot) => {
          receivedEvent = true;
          apply(snapshot);
        });
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      } catch (error) {
        console.error('[supervisor] snapshot listener failed', error);
        return;
      }
      try {
        const snapshot = await tauri.supervisorSnapshot();
        if (!disposed && !receivedEvent) apply(snapshot);
      } catch (error) {
        console.error('[supervisor] initial snapshot failed', error);
      }
    };
    void start();

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);
}
