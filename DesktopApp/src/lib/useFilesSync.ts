import { useEffect } from 'react';
import { useStore } from '../store';
import { tauri } from './tauri';

export const GIT_REFRESH_DEBOUNCE_MS = 500;

export function useFilesSync() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const gitTimers = new Map<number, ReturnType<typeof setTimeout>>();

    const scheduleGitRefresh = (projectId: number) => {
      const pending = gitTimers.get(projectId);
      if (pending !== undefined) clearTimeout(pending);
      gitTimers.set(projectId, setTimeout(() => {
        gitTimers.delete(projectId);
        useStore.getState().refreshGit(projectId).catch(() => undefined);
      }, GIT_REFRESH_DEBOUNCE_MS));
    };

    const start = async () => {
      try {
        const fn = await tauri.onFilesDirChanged(({ projectId, relDir }) => {
          const state = useStore.getState();
          if (state.fileTrees[projectId]?.listings[relDir]) void state.reloadFileDir(projectId, relDir);
          if (state.filesPanelOpen) scheduleGitRefresh(projectId);
          void state.checkFilesOnDisk(projectId, relDir);
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch (error) {
        console.error('[files] change listener failed', error);
      }
    };
    void start();

    return () => {
      disposed = true;
      if (unlisten) unlisten();
      gitTimers.forEach((timer) => clearTimeout(timer));
      gitTimers.clear();
    };
  }, []);
}
