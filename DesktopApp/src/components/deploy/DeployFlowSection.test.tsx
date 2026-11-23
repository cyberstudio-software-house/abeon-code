import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DeployFlow, RepoFlow } from '../../types';

const h = vi.hoisted(() => ({
  list: vi.fn(),
  detect: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  tauri: {
    deployListRepoFlows: h.list,
    deployDetectFlow: h.detect,
    deploySaveFlow: h.save,
    deployDeleteFlow: h.remove,
  },
}));

vi.mock('../../store', async () => {
  const { create } = await import('zustand');
  const { createDeploySlice } = await import('../../store/deploySlice');
  const useStore = create<import('../../store/deploySlice').DeploySlice>()((...a) => createDeploySlice(...a));
  return { useStore };
});

import { DeployFlowSection } from './DeployFlowSection';
import { useStore } from '../../store';

const blankFlow = (repoPath: string): DeployFlow => ({
  repoPath,
  enabled: true,
  remote: 'origin',
  build: 'none',
  buildRepo: '',
  productionBranch: 'main',
  delivery: 'none',
  namespace: '',
  workloads: [],
  kubeContext: null,
  updatedAt: 0,
});

const repo = (repoPath: string, label: string, flow: DeployFlow | null = null): RepoFlow => ({
  repoPath,
  label,
  remotes: ['origin', 'backup'],
  flow,
  proposal: null,
});

const detected: DeployFlow = {
  ...blankFlow('/p/api'),
  build: 'bitbucket',
  buildRepo: 'cybercode/api',
  productionBranch: 'master',
  delivery: 'image',
};

describe('DeployFlowSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ repoFlowsByProject: {} });
    h.list.mockResolvedValue([repo('/p/api', 'api')]);
    h.detect.mockResolvedValue(detected);
    h.save.mockResolvedValue(detected);
    h.remove.mockResolvedValue(undefined);
  });

  it('fills the form from detection without saving', async () => {
    render(<DeployFlowSection projectId={1} />);
    fireEvent.click(await screen.findByText('Wykryj z repozytorium'));
    await waitFor(() => {
      expect((screen.getByLabelText('Gałąź produkcyjna') as HTMLInputElement).value).toBe('master');
    });
    expect(h.detect).toHaveBeenCalledWith('/p/api');
    expect((screen.getByLabelText('Repozytorium (CI)') as HTMLInputElement).value).toBe('cybercode/api');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('saves the edited flow', async () => {
    render(<DeployFlowSection projectId={1} />);
    fireEvent.click(await screen.findByText('Obraz + Bandzior/Argo'));
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: ' cs-app-hs ' } });
    fireEvent.change(screen.getByLabelText('Zasoby'), { target: { value: 'app, worker' } });
    fireEvent.click(screen.getByText('Zapisz przepływ'));
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: '/p/api',
      namespace: 'cs-app-hs',
      workloads: ['app', 'worker'],
      delivery: 'image',
      kubeContext: null,
    }));
    expect(await screen.findByText('Zapisano')).toBeInTheDocument();
  });

  it('shows a repository picker only for a multi-repository project', async () => {
    const { unmount } = render(<DeployFlowSection projectId={1} />);
    await screen.findByText('Wykryj z repozytorium');
    expect(screen.queryByLabelText('Repozytorium')).toBeNull();
    unmount();

    h.list.mockResolvedValue([repo('/p/api', 'api'), repo('/p/web', 'web')]);
    useStore.setState({ repoFlowsByProject: {} });
    render(<DeployFlowSection projectId={1} />);
    const picker = (await screen.findByLabelText('Repozytorium')) as HTMLSelectElement;
    expect(Array.from(picker.options).map(o => o.textContent)).toEqual(['api', 'web']);

    fireEvent.change(picker, { target: { value: '/p/web' } });
    fireEvent.click(screen.getByText('Wykryj z repozytorium'));
    await waitFor(() => expect(h.detect).toHaveBeenCalledWith('/p/web'));
  });

  it('hides namespace and workloads when delivery is brak', async () => {
    render(<DeployFlowSection projectId={1} />);
    await screen.findByText('Wykryj z repozytorium');
    expect(screen.queryByLabelText('Namespace')).toBeNull();
    expect(screen.queryByLabelText('Zasoby')).toBeNull();
    expect(screen.queryByLabelText('Kontekst kubectl')).toBeNull();
    fireEvent.click(screen.getByText('Obraz + Bandzior/Argo'));
    expect(screen.getByLabelText('Namespace')).toBeInTheDocument();
    expect(screen.getByLabelText('Zasoby')).toBeInTheDocument();
    expect(screen.getByLabelText('Kontekst kubectl')).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('brak')[1]);
    expect(screen.queryByLabelText('Namespace')).toBeNull();
  });

  it('hides the CI repository when the build is brak', async () => {
    render(<DeployFlowSection projectId={1} />);
    await screen.findByText('Wykryj z repozytorium');
    expect(screen.queryByLabelText('Repozytorium (CI)')).toBeNull();
    fireEvent.click(screen.getByText('GitHub Actions'));
    expect(screen.getByLabelText('Repozytorium (CI)')).toBeInTheDocument();
  });

  it('shows the backend validation message', async () => {
    h.save.mockRejectedValue({ code: 'other', message: 'Przestrzeń nazw jest wymagana' });
    render(<DeployFlowSection projectId={1} />);
    fireEvent.click(await screen.findByText('Obraz + Bandzior/Argo'));
    fireEvent.click(screen.getByText('Zapisz przepływ'));
    expect(await screen.findByText('Przestrzeń nazw jest wymagana')).toBeInTheDocument();
    expect(screen.queryByText('Zapisano')).toBeNull();
  });

  it('says so when the project holds no repository', async () => {
    h.list.mockResolvedValue([]);
    render(<DeployFlowSection projectId={1} />);
    expect(await screen.findByText('Ten projekt nie zawiera repozytorium Git.')).toBeInTheDocument();
    expect(screen.queryByText('Zapisz przepływ')).toBeNull();
  });

  it('prefills a stored flow and removes it on request', async () => {
    h.list
      .mockResolvedValueOnce([repo('/p/api', 'api', { ...detected, namespace: 'cs-app-api', workloads: ['app'], updatedAt: 5 })])
      .mockResolvedValue([repo('/p/api', 'api')]);
    render(<DeployFlowSection projectId={1} />);
    expect((await screen.findByLabelText('Namespace') as HTMLInputElement).value).toBe('cs-app-api');
    expect((screen.getByLabelText('Zasoby') as HTMLInputElement).value).toBe('app');
    fireEvent.click(screen.getByText('Usuń przepływ'));
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('/p/api'));
    await waitFor(() => expect(screen.queryByText('Usuń przepływ')).toBeNull());
  });

  it('does not show the form when the repositories cannot be loaded', async () => {
    h.list.mockRejectedValue({ code: 'not_found', message: 'project 1' });
    render(<DeployFlowSection projectId={1} />);
    expect(await screen.findByText('project 1')).toBeInTheDocument();
    expect(screen.queryByText('Zapisz przepływ')).toBeNull();
  });
});
