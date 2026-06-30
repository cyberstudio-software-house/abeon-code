import { describe, it, expect, vi, beforeEach } from 'vitest';
import { create } from 'zustand';
import { createClickUpSlice, type ClickUpSlice } from './clickupSlice';

vi.mock('../lib/tauri', () => ({
  tauri: {
    clickupListLinks: vi.fn().mockResolvedValue([
      { projectId: 1, taskId: 't1', customId: 'CU-1', name: 'A', status: 'open', url: 'u', linkedAt: 1 },
    ]),
    clickupLinkTask: vi.fn().mockResolvedValue(
      { projectId: 1, taskId: 't2', customId: null, name: 'B', status: null, url: 'u2', linkedAt: 2 }),
    clickupUnlinkTask: vi.fn().mockResolvedValue(undefined),
  },
}));

const makeStore = () => create<ClickUpSlice>()((...a) => createClickUpSlice(...a));

describe('clickupSlice', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads links for a project', async () => {
    const s = makeStore();
    await s.getState().loadLinks(1);
    expect(s.getState().linksByProject[1]).toHaveLength(1);
    expect(s.getState().linksByProject[1][0].name).toBe('A');
  });

  it('appends a linked task', async () => {
    const s = makeStore();
    await s.getState().loadLinks(1);
    await s.getState().linkTask(1, 't2');
    expect(s.getState().linksByProject[1].map(l => l.taskId)).toContain('t2');
  });
});
