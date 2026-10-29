import { useEffect } from 'react';
import { useStore } from '../store';

export function useSupervisorAutoOpen() {
  useEffect(() => {
    let opened = false;
    let previous = useStore.getState().supervisorLevel;
    return useStore.subscribe((state) => {
      const next = state.supervisorLevel;
      if (!opened && previous === 'off' && next !== 'off') {
        opened = true;
        state.openSupervisorPanel();
      }
      previous = next;
    });
  }, []);
}
