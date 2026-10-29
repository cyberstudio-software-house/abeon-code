import { useEffect } from 'react';
import { useStore } from '../store';
import { tauri } from './tauri';

export function useSupervisorSnapshot() {
  useEffect(() => {
    let disposed = false;
    let receivedEvent = false;
    let unlisten: (() => void) | null = null;
    const apply = useStore.getState().setSupervisorSnapshot;

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
