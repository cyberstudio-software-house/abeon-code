import { describe, it, expect, vi, beforeEach } from 'vitest';

const check = vi.fn();
const relaunch = vi.fn();
vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => check() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => relaunch() }));

import { checkForUpdate } from './updater';

describe('checkForUpdate', () => {
  beforeEach(() => { check.mockReset(); relaunch.mockReset(); });

  it('returns null when no update is available', async () => {
    check.mockResolvedValue(null);
    expect(await checkForUpdate()).toBeNull();
  });

  it('returns null and swallows errors when check throws', async () => {
    check.mockRejectedValue(new Error('offline'));
    expect(await checkForUpdate()).toBeNull();
  });

  it('maps an available update to version + notes', async () => {
    check.mockResolvedValue({ version: '0.2.0', body: 'Nowości', downloadAndInstall: vi.fn() });
    const update = await checkForUpdate();
    expect(update?.version).toBe('0.2.0');
    expect(update?.notes).toBe('Nowości');
  });

  it('forwards download progress to the callback', async () => {
    const downloadAndInstall = vi.fn(async (onEvent: (e: unknown) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent({ event: 'Progress', data: { chunkLength: 60 } });
      onEvent({ event: 'Finished' });
    });
    check.mockResolvedValue({ version: '0.2.0', body: '', downloadAndInstall });
    const update = await checkForUpdate();
    const seen: Array<[number, number | null]> = [];
    await update!.downloadAndInstall((d, t) => seen.push([d, t]));
    expect(seen).toEqual([[40, 100], [100, 100]]);
  });

  it('reports total as null when the stream has no contentLength', async () => {
    const downloadAndInstall = vi.fn(async (onEvent: (e: unknown) => void) => {
      onEvent({ event: 'Started', data: {} });
      onEvent({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent({ event: 'Finished' });
    });
    check.mockResolvedValue({ version: '0.2.0', body: '', downloadAndInstall });
    const update = await checkForUpdate();
    const seen: Array<[number, number | null]> = [];
    await update!.downloadAndInstall((d, t) => seen.push([d, t]));
    expect(seen).toEqual([[40, null]]);
  });

  it('propagates errors thrown during download', async () => {
    const downloadAndInstall = vi.fn(async () => { throw new Error('connection lost'); });
    check.mockResolvedValue({ version: '0.2.0', body: '', downloadAndInstall });
    const update = await checkForUpdate();
    await expect(update!.downloadAndInstall()).rejects.toThrow('connection lost');
  });
});
