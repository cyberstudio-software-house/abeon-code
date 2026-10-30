import { useEffect } from 'react';
import { useStore } from '../store';

export function useMouseNavigation(): void {
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if ((e.button === 3 || e.button === 4) && useStore.getState().settingsOpen) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.button === 3) {
        e.preventDefault();
        e.stopPropagation();
        useStore.getState().goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
        useStore.getState().goForward();
      }
    };
    document.addEventListener('mousedown', onMouseDown, { capture: true });
    return () => document.removeEventListener('mousedown', onMouseDown, { capture: true });
  }, []);
}
