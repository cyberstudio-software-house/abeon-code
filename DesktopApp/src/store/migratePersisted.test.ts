import { beforeEach, describe, it, expect, vi } from 'vitest';

const getAllSettings = vi.fn(async (): Promise<Record<string, string>> => ({}));

vi.mock('../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tauri')>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      getAllSettings: () => getAllSettings(),
      setSetting: async () => {},
      detectDefaultShell: async () => '',
      takePendingOpenPaths: async () => [],
    },
  };
});

describe('migratePersisted', () => {
  it('migrates legacy Claude model settings and keeps other keys', async () => {
    const { migratePersisted } = await import('./index');
    expect(migratePersisted({
      theme: 'light',
      defaultModelId: 'custom-a',
      titleGenModelId: 'haiku-4.5',
      modelEfforts: { 'opus-4.8-1m': 'high' },
      customModels: [{ id: 'custom-a', modelId: 'claude-x-1', label: 'X' }],
    }, [])).toEqual({
      theme: 'light',
      defaultModelId: 'claude-x-1',
      titleGenModelId: 'haiku',
      modelEfforts: { 'claude-opus-4-8[1m]': 'high' },
      customModels: [{ modelId: 'claude-x-1', label: 'X' }],
    });
  });

  it('does not add keys the snapshot lacks', async () => {
    const { migratePersisted } = await import('./index');
    expect(migratePersisted({ theme: 'dark' }, [{ modelId: 'claude-x-1', label: 'X' }])).toEqual({ theme: 'dark' });
  });

  it('resolves ids against the fallback custom models', async () => {
    const { migratePersisted } = await import('./index');
    expect(migratePersisted({ defaultModelId: 'custom-model' }, [{ modelId: 'custom-model', label: 'M' }]))
      .toEqual({ defaultModelId: 'custom-model' });
  });
});

describe('store boot with legacy Claude model settings', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
  });

  it('migrates the localStorage snapshot', async () => {
    localStorage.setItem('abeoncode.settings', JSON.stringify({
      defaultModelId: 'opus-4.8-1m',
      titleGenModelId: 'haiku-4.5',
      modelEfforts: { 'opus-4.8-1m': 'high' },
    }));
    const { useStore } = await import('./index');
    const s = useStore.getState();
    expect(s.defaultModelId).toBe('claude-opus-4-8[1m]');
    expect(s.titleGenModelId).toBe('haiku');
    expect(s.modelEfforts).toEqual({ 'claude-opus-4-8[1m]': 'high' });
  });

  it('migrates the SQLite snapshot and writes it back to localStorage', async () => {
    getAllSettings.mockResolvedValue({
      migrated_v2: '1',
      defaultModelId: 'custom-a',
      customModels: JSON.stringify([{ id: 'custom-a', modelId: 'claude-x-1', label: 'X' }]),
    });
    const { useStore } = await import('./index');
    await vi.waitFor(() => expect(useStore.getState().defaultModelId).toBe('claude-x-1'));
    expect(useStore.getState().customModels).toEqual([{ modelId: 'claude-x-1', label: 'X' }]);
    const local = JSON.parse(localStorage.getItem('abeoncode.settings') ?? '{}');
    expect(local.defaultModelId).toBe('claude-x-1');
    expect(local.customModels).toEqual([{ modelId: 'claude-x-1', label: 'X' }]);
  });
});
