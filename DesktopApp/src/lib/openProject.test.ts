import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '../types';

const findOrCreateProject = vi.fn();
const listProjects = vi.fn();

vi.mock('./tauri', () => ({
  tauri: {
    findOrCreateProject: (p: string) => findOrCreateProject(p),
    listProjects: () => listProjects(),
  },
}));

import { openProjectPath } from './openProject';
import { useStore } from '../store';

const project: Project = {
  id: 42, name: 'demo', path: '/x/demo', claudeDir: '-x-demo',
  color: null, sortOrder: 0, createdAt: 0,
};

describe('openProjectPath', () => {
  beforeEach(() => {
    findOrCreateProject.mockReset().mockResolvedValue(project);
    listProjects.mockReset().mockResolvedValue([project]);
    useStore.setState({ tabs: [], activeTabId: null, enabledProviders: ['claude'] });
  });

  it('resolves the project then opens a new session tab', async () => {
    await openProjectPath('/x/demo');
    expect(findOrCreateProject).toHaveBeenCalledWith('/x/demo');
    expect(listProjects).toHaveBeenCalled();
    const tabs = useStore.getState().tabs;
    expect(tabs.length).toBe(1);
    expect(tabs[0].projectId).toBe(42);
  });

  it('swallows errors from the command', async () => {
    findOrCreateProject.mockRejectedValue(new Error('bad path'));
    await expect(openProjectPath('/nope')).resolves.toBeUndefined();
    expect(useStore.getState().tabs.length).toBe(0);
  });
});
