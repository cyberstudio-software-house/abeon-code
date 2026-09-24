import { beforeEach, describe, it, expect, vi } from 'vitest';

let db: Record<string, string> = {};
const getAllSettings = vi.fn(async (): Promise<Record<string, string>> => ({ ...db }));
const setSetting = vi.fn(async (key: string, value: string) => { db[key] = value; });

vi.mock('../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tauri')>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      getAllSettings: () => getAllSettings(),
      setSetting: (key: string, value: string) => setSetting(key, value),
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

  it('keeps Auto for both model ids', async () => {
    const { migratePersisted } = await import('./index');
    expect(migratePersisted({ defaultModelId: '', titleGenModelId: '' }, []))
      .toEqual({ defaultModelId: '', titleGenModelId: '' });
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
    db = {};
    getAllSettings.mockReset();
    getAllSettings.mockImplementation(async () => ({ ...db }));
    setSetting.mockClear();
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

  it('restores Auto as the title generation model from localStorage', async () => {
    localStorage.setItem('abeoncode.settings', JSON.stringify({ titleGenModelId: '' }));
    const { useStore } = await import('./index');
    expect(useStore.getState().titleGenModelId).toBe('');
  });

  it('restores Auto for both model ids from SQLite over non-empty local values', async () => {
    localStorage.setItem('abeoncode.settings', JSON.stringify({
      defaultModelId: 'claude-opus-5-5',
      titleGenModelId: 'claude-sonnet-5',
    }));
    getAllSettings.mockResolvedValue({ migrated_v2: '1', defaultModelId: '', titleGenModelId: '' });
    const { useStore } = await import('./index');
    await vi.waitFor(() => expect(useStore.getState().defaultModelId).toBe(''));
    expect(useStore.getState().titleGenModelId).toBe('');
    const local = JSON.parse(localStorage.getItem('abeoncode.settings') ?? '{}');
    expect(local.defaultModelId).toBe('');
    expect(local.titleGenModelId).toBe('');
  });

  it('writes migrated Claude model settings back to SQLite', async () => {
    db = {
      migrated_v2: '1',
      defaultModelId: 'custom-a',
      titleGenModelId: 'custom-a',
      modelEfforts: JSON.stringify({ 'custom-a': 'high' }),
      customModels: JSON.stringify([{ id: 'custom-a', modelId: 'claude-x-1', label: 'X' }]),
      theme: 'light',
    };
    const { useStore } = await import('./index');
    await vi.waitFor(() => expect(useStore.getState().defaultModelId).toBe('claude-x-1'));
    await vi.waitFor(() => expect(db.customModels).toBe(JSON.stringify([{ modelId: 'claude-x-1', label: 'X' }])));
    expect(db.defaultModelId).toBe('claude-x-1');
    expect(db.titleGenModelId).toBe('claude-x-1');
    expect(db.modelEfforts).toBe(JSON.stringify({ 'claude-x-1': 'high' }));
    expect(setSetting.mock.calls.map(([key]) => key).sort())
      .toEqual(['customModels', 'defaultModelId', 'modelEfforts', 'titleGenModelId']);
  });

  it('does not rewrite Claude model settings that are already migrated', async () => {
    db = {
      migrated_v2: '1',
      defaultModelId: 'claude-x-1',
      customModels: JSON.stringify([{ modelId: 'claude-x-1', label: 'X' }]),
    };
    const { useStore } = await import('./index');
    await vi.waitFor(() => expect(useStore.getState().defaultModelId).toBe('claude-x-1'));
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('keeps a legacy custom selection after adding a model and restarting', async () => {
    db = {
      migrated_v2: '1',
      defaultModelId: 'custom-a',
      modelEfforts: JSON.stringify({ 'custom-a': 'high' }),
      customModels: JSON.stringify([{ id: 'custom-a', modelId: 'claude-x-1', label: 'X' }]),
    };
    const first = await import('./index');
    await vi.waitFor(() => expect(first.useStore.getState().defaultModelId).toBe('claude-x-1'));
    first.useStore.getState().addCustomModel({ modelId: 'claude-y-2', label: 'Y' });
    await vi.waitFor(() => expect(db.customModels).toContain('claude-y-2'));

    vi.resetModules();
    const second = await import('./index');
    await vi.waitFor(() => expect(getAllSettings).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(second.useStore.getState().customModels).toHaveLength(2));
    expect(second.useStore.getState().defaultModelId).toBe('claude-x-1');
    expect(second.useStore.getState().modelEfforts).toEqual({ 'claude-x-1': 'high' });
  });
});
