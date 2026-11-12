import { check } from '@tauri-apps/plugin-updater';
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type AvailableUpdate = {
  version: string;
  notes: string;
  download: (onProgress?: (downloaded: number, total: number | null) => void) => Promise<void>;
  install: () => Promise<void>;
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
  let downloading: Promise<void> | null = null;
  let installing: Promise<void> | null = null;
  return {
    version: u.version,
    notes: u.body ?? '',
    download: (onProgress) => {
      if (!downloading) {
        let downloaded = 0;
        let total: number | null = null;
        downloading = u.download((event: DownloadEvent) => {
          if (event.event === 'Started') {
            total = event.data.contentLength ?? null;
          } else if (event.event === 'Progress') {
            downloaded += event.data.chunkLength;
            onProgress?.(downloaded, total);
          }
        }).catch((err: unknown) => {
          downloading = null;
          throw err;
        });
      }
      return downloading;
    },
    install: () => {
      installing ??= u.install().catch((err: unknown) => {
        installing = null;
        throw err;
      });
      return installing;
    },
    relaunch,
  };
}
