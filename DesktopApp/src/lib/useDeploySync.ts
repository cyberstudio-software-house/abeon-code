import { useEffect } from 'react';
import { useStore } from '../store';
import { tauri } from './tauri';

export function useDeploySync() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const reload = () => {
      useStore.getState().loadTrackings().catch(error => {
        console.error('[deploy] loading trackings failed', error);
      });
    };
    reload();
    tauri.onDeployChanged(reload)
      .then(fn => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(error => console.error('[deploy] change listener failed', error));
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);
}
