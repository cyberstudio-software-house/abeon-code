import { useEffect } from 'react';
import { useStore } from '../store';
import { onFileSaved } from '../store/filesSlice';
import { tauri } from './tauri';

export const GIT_REFRESH_DEBOUNCE_MS = 500;
export const FILES_RECHECK_INTERVAL_MS = 2000;

export function useFilesSync() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const gitTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let recheckCooldown: ReturnType<typeof setTimeout> | null = null;
    let recheckQueued = false;

    const scheduleGitRefresh = (projectId: number) => {
      const pending = gitTimers.get(projectId);
      if (pending !== undefined) clearTimeout(pending);
      gitTimers.set(projectId, setTimeout(() => {
        gitTimers.delete(projectId);
        useStore.getState().refreshGit(projectId).catch(() => undefined);
      }, GIT_REFRESH_DEBOUNCE_MS));
    };

    const recheckFiles = () => {
      if (recheckCooldown !== null) {
        recheckQueued = true;
        return;
      }
      useStore.getState().recheckFiles().catch(() => undefined);
      recheckCooldown = setTimeout(() => {
        recheckCooldown = null;
        if (!recheckQueued) return;
        recheckQueued = false;
        recheckFiles();
      }, FILES_RECHECK_INTERVAL_MS);
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

    const stopSaveListener = onFileSaved(scheduleGitRefresh);
    const stopTabListener = useStore.subscribe((state, prev) => {
      if (state.activeTabId === prev.activeTabId) return;
      if (state.tabs.find((tab) => tab.id === state.activeTabId)?.kind === 'file') recheckFiles();
    });
    window.addEventListener('focus', recheckFiles);

    return () => {
      disposed = true;
      if (unlisten) unlisten();
      stopSaveListener();
      stopTabListener();
      window.removeEventListener('focus', recheckFiles);
      if (recheckCooldown !== null) clearTimeout(recheckCooldown);
      gitTimers.forEach((timer) => clearTimeout(timer));
      gitTimers.clear();
    };
  }, []);
}
