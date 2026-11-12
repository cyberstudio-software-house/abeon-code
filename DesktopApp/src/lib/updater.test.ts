import { describe, it, expect, vi, beforeEach } from 'vitest';

const check = vi.fn();
const relaunch = vi.fn();
vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => check() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => relaunch() }));

import { checkForUpdate } from './updater';

type Emit = (e: unknown) => void;

const pluginUpdate = (download: (onEvent: Emit) => Promise<void>, install = vi.fn(async () => undefined)) => ({
  version: '0.2.0',
  body: '',
  download: vi.fn(download),
  install,
  downloadAndInstall: vi.fn(),
});

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
    check.mockResolvedValue({ version: '0.2.0', body: 'Nowości', download: vi.fn(), install: vi.fn() });
    const update = await checkForUpdate();
    expect(update?.version).toBe('0.2.0');
    expect(update?.notes).toBe('Nowości');
  });

  it('forwards download progress to the callback', async () => {
    const plugin = pluginUpdate(async (onEvent) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent({ event: 'Progress', data: { chunkLength: 60 } });
      onEvent({ event: 'Finished' });
    });
    check.mockResolvedValue(plugin);
    const update = await checkForUpdate();
    const seen: Array<[number, number | null]> = [];
    await update!.download((d, t) => seen.push([d, t]));
    expect(seen).toEqual([[40, 100], [100, 100]]);
  });

  it('reports total as null when the stream has no contentLength', async () => {
    const plugin = pluginUpdate(async (onEvent) => {
      onEvent({ event: 'Started', data: {} });
      onEvent({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent({ event: 'Finished' });
    });
    check.mockResolvedValue(plugin);
    const update = await checkForUpdate();
    const seen: Array<[number, number | null]> = [];
    await update!.download((d, t) => seen.push([d, t]));
    expect(seen).toEqual([[40, null]]);
  });

  it('propagates errors thrown during download', async () => {
    check.mockResolvedValue(pluginUpdate(async () => { throw new Error('connection lost'); }));
    const update = await checkForUpdate();
    await expect(update!.download()).rejects.toThrow('connection lost');
  });

  it('downloads only once, so a retry after a refused install does not download again', async () => {
    const plugin = pluginUpdate(async () => undefined);
    check.mockResolvedValue(plugin);
    const update = await checkForUpdate();
    await update!.download();
    await update!.download();
    expect(plugin.download).toHaveBeenCalledTimes(1);
    await update!.install();
    expect(plugin.install).toHaveBeenCalledTimes(1);
    expect(plugin.downloadAndInstall).not.toHaveBeenCalled();
  });

  it('downloads again after a failed download', async () => {
    const plugin = pluginUpdate(async () => undefined);
    plugin.download.mockRejectedValueOnce(new Error('connection lost'));
    check.mockResolvedValue(plugin);
    const update = await checkForUpdate();
    await expect(update!.download()).rejects.toThrow('connection lost');
    await update!.download();
    expect(plugin.download).toHaveBeenCalledTimes(2);
  });

  it('installs only once, so a retry after a refusal before the relaunch does not install again', async () => {
    const plugin = pluginUpdate(async () => undefined);
    check.mockResolvedValue(plugin);
    const update = await checkForUpdate();
    await update!.download();
    await update!.install();
    await update!.install();
    expect(plugin.install).toHaveBeenCalledTimes(1);
  });

  it('installs again after a failed install, without downloading again', async () => {
    const plugin = pluginUpdate(async () => undefined);
    plugin.install.mockRejectedValueOnce(new Error('pkexec dismissed'));
    check.mockResolvedValue(plugin);
    const update = await checkForUpdate();
    await update!.download();
    await expect(update!.install()).rejects.toThrow('pkexec dismissed');
    await update!.download();
    await update!.install();
    expect(plugin.download).toHaveBeenCalledTimes(1);
    expect(plugin.install).toHaveBeenCalledTimes(2);
  });

  it('installs through the plugin and relaunches through the process plugin', async () => {
    const plugin = pluginUpdate(async () => undefined);
    check.mockResolvedValue(plugin);
    const update = await checkForUpdate();
    await update!.download();
    await update!.install();
    await update!.relaunch();
    expect(plugin.install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
