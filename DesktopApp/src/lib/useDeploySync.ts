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
    const start = async () => {
      try {
        const fn = await tauri.onDeployChanged(reload);
        if (disposed) fn();
        else unlisten = fn;
      } catch (error) {
        console.error('[deploy] change listener failed', error);
      }
      if (!disposed) reload();
    };
    void start();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);
}
