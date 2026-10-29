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

describe('supervisor settings persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    db = {};
    getAllSettings.mockReset();
    getAllSettings.mockImplementation(async () => ({ ...db }));
    setSetting.mockClear();
  });

  it('starts with the documented defaults', async () => {
    const { useStore } = await import('./index');
    const s = useStore.getState();
    expect(s.supervisorLevel).toBe('off');
    expect(s.supervisorGraceSeconds).toBe(60);
    expect(s.supervisorPresenceMinutes).toBe(5);
    expect(s.supervisorModelId).toBe('');
    expect(s.supervisorExtraRules).toEqual([]);
  });

  it('ignores non-finite grace and presence values', async () => {
    const { useStore } = await import('./index');
    useStore.getState().setSupervisorGraceSeconds(90);
    useStore.getState().setSupervisorPresenceMinutes(10);
    for (const bad of [NaN, Infinity, -Infinity]) {
      useStore.getState().setSupervisorGraceSeconds(bad);
      useStore.getState().setSupervisorPresenceMinutes(bad);
    }
    expect(useStore.getState().supervisorGraceSeconds).toBe(90);
    expect(useStore.getState().supervisorPresenceMinutes).toBe(10);
  });

  it('serializes the five keys as the backend loader expects', async () => {
    const { useStore } = await import('./index');
    useStore.getState().setSupervisorLevel('assistant');
    useStore.getState().setSupervisorGraceSeconds(90);
    useStore.getState().setSupervisorPresenceMinutes(10);
    useStore.getState().setSupervisorModelId('claude-opus-5-5');
    useStore.getState().setSupervisorExtraRules([' bash:^rm ', 'mcp:foo__*']);
    await vi.waitFor(() => expect(Object.keys(db).sort()).toEqual([
      'supervisorExtraRules', 'supervisorGraceSeconds', 'supervisorLevel',
      'supervisorModelId', 'supervisorPresenceMinutes',
    ]));
    expect(db).toEqual({
      supervisorLevel: 'assistant',
      supervisorGraceSeconds: '90',
      supervisorPresenceMinutes: '10',
      supervisorModelId: 'claude-opus-5-5',
      supervisorExtraRules: JSON.stringify(['bash:^rm', 'mcp:foo__*']),
    });
  });

  it('round-trips the five keys through SQLite hydration', async () => {
    getAllSettings.mockResolvedValue({
      migrated_v2: '1',
      supervisorLevel: 'autonomous',
      supervisorGraceSeconds: '120',
      supervisorPresenceMinutes: '15',
      supervisorModelId: 'claude-sonnet-5',
      supervisorExtraRules: JSON.stringify(['bash:^kubectl delete']),
    });
    const { useStore } = await import('./index');
    await vi.waitFor(() => expect(useStore.getState().supervisorLevel).toBe('autonomous'));
    const s = useStore.getState();
    expect(s.supervisorGraceSeconds).toBe(120);
    expect(s.supervisorPresenceMinutes).toBe(15);
    expect(s.supervisorModelId).toBe('claude-sonnet-5');
    expect(s.supervisorExtraRules).toEqual(['bash:^kubectl delete']);
    expect(setSetting.mock.calls.filter(([key]) => String(key).startsWith('supervisor'))).toEqual([]);
  });

  it('clamps grace to 15-300 and presence to 1-60 on load', async () => {
    getAllSettings.mockResolvedValue({
      migrated_v2: '1',
      supervisorGraceSeconds: '5',
      supervisorPresenceMinutes: '0',
    });
    const { useStore } = await import('./index');
    await vi.waitFor(() => expect(useStore.getState().supervisorGraceSeconds).toBe(15));
    expect(useStore.getState().supervisorPresenceMinutes).toBe(1);

    getAllSettings.mockResolvedValue({
      migrated_v2: '1',
      supervisorGraceSeconds: '9999',
      supervisorPresenceMinutes: '500',
    });
    vi.resetModules();
    const reloaded = (await import('./index')).useStore;
    await vi.waitFor(() => expect(reloaded.getState().supervisorGraceSeconds).toBe(300));
    expect(reloaded.getState().supervisorPresenceMinutes).toBe(60);
  });

  it('keeps an empty model id as the default model and ignores an unknown level', async () => {
    getAllSettings.mockResolvedValue({
      migrated_v2: '1',
      supervisorModelId: '',
      supervisorLevel: 'chaos',
    });
    localStorage.setItem('abeoncode.settings', JSON.stringify({ supervisorModelId: 'claude-x' }));
    const { useStore } = await import('./index');
    await vi.waitFor(() => expect(useStore.getState().supervisorModelId).toBe(''));
    expect(useStore.getState().supervisorLevel).toBe('off');
  });

  it('drops malformed extra rules', async () => {
    getAllSettings.mockResolvedValue({
      migrated_v2: '1',
      supervisorExtraRules: JSON.stringify(['bash:a', 7, null, 'mcp:b']),
    });
    const { useStore } = await import('./index');
    await vi.waitFor(() => expect(useStore.getState().supervisorExtraRules).toEqual(['bash:a', 'mcp:b']));
  });

  it('persists the Discord toggles', async () => {
    const { useStore } = await import('./index');
    expect(useStore.getState().supervisorDiscordEnabled).toBe(false);
    expect(useStore.getState().supervisorDiscordMuteWhenPresent).toBe(true);
    useStore.getState().setSupervisorDiscordEnabled(true);
    useStore.getState().setSupervisorDiscordMuteWhenPresent(false);
    await vi.waitFor(() => expect(db).toEqual({
      supervisorDiscordEnabled: 'true',
      supervisorDiscordMuteWhenPresent: 'false',
    }));

    getAllSettings.mockResolvedValue({
      migrated_v2: '1',
      supervisorDiscordEnabled: 'true',
      supervisorDiscordMuteWhenPresent: 'false',
    });
    vi.resetModules();
    const reloaded = (await import('./index')).useStore;
    await vi.waitFor(() => expect(reloaded.getState().supervisorDiscordEnabled).toBe(true));
    expect(reloaded.getState().supervisorDiscordMuteWhenPresent).toBe(false);
  });
});
