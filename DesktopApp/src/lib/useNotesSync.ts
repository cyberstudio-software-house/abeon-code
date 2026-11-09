import { useEffect } from 'react';
import { toast } from 'sonner';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useStore } from '../store';
import { tauri } from './tauri';

const MAIN_WINDOW_LABEL = 'main';

export function useNotesSync() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const ownLabel = getCurrentWebviewWindow().label;
    const start = async () => {
      try {
        const fn = await tauri.onNotesChanged((event) => {
          if (event.sourceWindow === ownLabel) return;
          void useStore.getState().reloadNotes();
          if (ownLabel === MAIN_WINDOW_LABEL && event.external && event.createdNoteId != null) {
            toast.success('Dodano notatkę');
          }
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch (error) {
        console.error('[notes] change listener failed', error);
      }
    };
    void start();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);
}
