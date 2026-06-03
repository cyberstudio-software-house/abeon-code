import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from './index';
import { tauri } from '../lib/tauri';
import type { Project } from '../types';

function fakeProject(id: number, name: string, color: string | null = null): Project {
  return { id, name, path: `/p/${id}`, claudeDir: `-p-${id}`, color, sortOrder: id, createdAt: 0 };
}

describe('projectsSlice updateProject', () => {
  beforeEach(() => { useStore.setState({ projects: [fakeProject(1, 'alpha'), fakeProject(2, 'beta')] }); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('replaces the edited project with the backend-returned value', async () => {
    vi.spyOn(tauri, 'updateProject').mockResolvedValue(fakeProject(2, 'beta-renamed', '#b78640'));
    await useStore.getState().updateProject(2, { name: 'beta-renamed', color: '#b78640' });
    expect(tauri.updateProject).toHaveBeenCalledWith(2, { name: 'beta-renamed', color: '#b78640' });
    const beta = useStore.getState().projects.find(p => p.id === 2);
    expect(beta).toEqual(fakeProject(2, 'beta-renamed', '#b78640'));
    expect(useStore.getState().projects.find(p => p.id === 1)?.name).toBe('alpha');
  });
});
