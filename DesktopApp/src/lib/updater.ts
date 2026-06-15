import { check } from '@tauri-apps/plugin-updater';
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type AvailableUpdate = {
  version: string;
  notes: string;
  downloadAndInstall: (onProgress?: (downloaded: number, total: number | null) => void) => Promise<void>;
  relaunch: () => Promise<void>;
};

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  let update: Update | null;
  try {
    update = await check();
  } catch (err) {
    console.error('Update check failed', err);
    return null;
  }
  if (!update) return null;

  const u = update;
  return {
    version: u.version,
    notes: u.body ?? '',
    downloadAndInstall: async (onProgress) => {
      let downloaded = 0;
      let total: number | null = null;
      await u.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          onProgress?.(downloaded, total);
        }
      });
    },
    relaunch,
  };
}
