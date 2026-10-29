import { useEffect } from 'react';
import { useStore } from '../store';
import { tauri } from './tauri';

export function useSupervisorSnapshot() {
  useEffect(() => {
    let disposed = false;
    let receivedEvent = false;
    let unlisten: (() => void) | null = null;
    const apply = useStore.getState().setSupervisorSnapshot;

    tauri.onSupervisorSnapshot((snapshot) => {
      receivedEvent = true;
      apply(snapshot);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});

    tauri.supervisorSnapshot().then((snapshot) => {
      if (!disposed && !receivedEvent) apply(snapshot);
    }).catch(() => {});

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);
}
