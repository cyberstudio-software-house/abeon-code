import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OpenRequest, Project } from '../types';

const findOrCreateProject = vi.fn();
const listProjects = vi.fn();
const toastError = vi.fn();

vi.mock('./tauri', () => ({
  tauri: {
    findOrCreateProject: (p: string) => findOrCreateProject(p),
    listProjects: () => listProjects(),
  },
}));
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m) } }));

import { openProjectPath } from './openProject';
import { useStore } from '../store';

const project: Project = {
  id: 42, name: 'demo', path: '/x/demo', claudeDir: '-x-demo',
  color: null, sortOrder: 0, createdAt: 0,
};

const req = (over: Partial<OpenRequest> = {}): OpenRequest => ({
  path: '/x/demo', initialPrompt: null, background: false, ...over,
});

describe('openProjectPath', () => {
  beforeEach(() => {
    findOrCreateProject.mockReset().mockResolvedValue(project);
    listProjects.mockReset().mockResolvedValue([project]);
    toastError.mockReset();
    useStore.setState({ tabs: [], activeTabId: null, mruOrder: [], enabledProviders: ['claude'] });
  });

  it('resolves the project then opens a new session tab', async () => {
    await openProjectPath(req());
    expect(findOrCreateProject).toHaveBeenCalledWith('/x/demo');
    expect(listProjects).toHaveBeenCalled();
    const tabs = useStore.getState().tabs;
    expect(tabs.length).toBe(1);
    expect(tabs[0].projectId).toBe(42);
  });

  it('opens a background prompted tab without activating it', async () => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 't1', projectId: 1, title: 'a' }],
      activeTabId: 't1',
      mruOrder: ['t1'],
    });
    await openProjectPath(req({ initialPrompt: 'Do X', background: true }));
    const s = useStore.getState();
    expect(s.activeTabId).toBe('t1');
    const created = s.tabs.find(t => t.kind === 'session');
    expect(created).toMatchObject({ projectId: 42, initialPrompt: 'Do X', provider: 'claude' });
  });

  it('activates a prompted tab when not in background', async () => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 't1', projectId: 1, title: 'a' }],
      activeTabId: 't1',
      mruOrder: ['t1'],
    });
    await openProjectPath(req({ initialPrompt: 'Do X', background: false }));
    const s = useStore.getState();
    const created = s.tabs.find(t => t.kind === 'session');
    expect(s.activeTabId).toBe(created?.id);
  });

  it('shows a toast and opens nothing when the project cannot be resolved', async () => {
    findOrCreateProject.mockRejectedValue(new Error('bad path'));
    await expect(openProjectPath(req({ path: '/nope', initialPrompt: 'x', background: true }))).resolves.toBeUndefined();
    expect(useStore.getState().tabs.length).toBe(0);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('/nope'));
  });
});
