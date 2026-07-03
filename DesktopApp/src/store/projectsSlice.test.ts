import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from './index';
import { selectSortedProjects } from './projectsSlice';
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

describe('projectsSlice activity sort stability', () => {
  beforeEach(() => {
    useStore.setState({
      projects: [fakeProject(1, 'alpha'), fakeProject(2, 'beta'), fakeProject(3, 'gamma')],
      activity: {},
      activityOrder: [],
      sortMode: 'activity',
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('follows the frozen activityOrder instead of live activity', () => {
    useStore.setState({
      activity: { 1: 100, 2: 300, 3: 200 },
      activityOrder: [1, 2, 3],
    });
    const ids = selectSortedProjects(useStore.getState()).map(p => p.id);
    expect(ids).toEqual([1, 2, 3]);
  });

  it('establishes activityOrder by activity descending on first load', async () => {
    vi.spyOn(tauri, 'getProjectsActivity').mockResolvedValue({ 1: 100, 2: 300, 3: 200 });
    await useStore.getState().loadActivity();
    expect(useStore.getState().activityOrder).toEqual([2, 3, 1]);
  });

  it('appends newly-active projects at the end without reordering the frozen ones', async () => {
    useStore.setState({ activity: { 1: 100, 2: 300 }, activityOrder: [2, 1] });
    vi.spyOn(tauri, 'getProjectsActivity').mockResolvedValue({ 1: 100, 2: 300, 3: 999 });
    await useStore.getState().loadActivity();
    expect(useStore.getState().activityOrder).toEqual([2, 1, 3]);
  });
});
