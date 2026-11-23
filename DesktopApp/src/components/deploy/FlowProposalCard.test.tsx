import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProposalView } from '../../types';

const h = vi.hoisted(() => ({
  list: vi.fn(),
  resolve: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  tauri: {
    deployListProposals: h.list,
    deployResolveProposal: h.resolve,
  },
}));

vi.mock('sonner', () => ({ toast: { error: h.toastError } }));

vi.mock('../../store', async () => {
  const { create } = await import('zustand');
  const { createDeploySlice } = await import('../../store/deploySlice');
  const useStore = create<import('../../store/deploySlice').DeploySlice>()((...a) => createDeploySlice(...a));
  return { useStore };
});

import { FlowProposalCard } from './FlowProposalCard';
import { useStore } from '../../store';

const view: ProposalView = {
  proposal: {
    id: 'ab12cd34',
    repoPath: '/p/yachtic/api',
    flow: {
      repoPath: '/p/yachtic/api',
      enabled: true,
      remote: 'origin',
      build: 'bitbucket',
      buildRepo: 'cybercode/api',
      productionBranch: 'main',
      delivery: 'image',
      namespace: 'cs-app-api',
      workloads: ['app'],
      kubeContext: null,
      updatedAt: 0,
    },
    createdAt: 1,
    expiresAt: 2,
  },
  repoLabel: 'api',
  projectIds: [1],
  changes: [
    { field: 'productionBranch', label: 'Gałąź produkcyjna', before: 'master', after: 'main' },
    { field: 'namespace', label: 'Namespace', before: null, after: 'cs-app-api' },
  ],
};

describe('FlowProposalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ proposals: [view] });
    h.list.mockResolvedValue([]);
    h.resolve.mockResolvedValue(undefined);
  });

  it('shows the repository and lists the changes', () => {
    render(<FlowProposalCard view={view} />);
    expect(screen.getByRole('region', { name: 'Agent proponuje przepływ wdrożenia: api' })).toBeInTheDocument();
    expect(screen.getByText('Agent proponuje przepływ wdrożenia: api')).toBeInTheDocument();
    expect(screen.getByText('/p/yachtic/api')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Gałąź produkcyjna: master → main',
      'Namespace: cs-app-api',
    ]);
  });

  it('approves with Zatwierdź', async () => {
    render(<FlowProposalCard view={view} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zatwierdź' }));
    await waitFor(() => expect(h.resolve).toHaveBeenCalledWith('ab12cd34', true));
    expect(h.resolve).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useStore.getState().proposals).toEqual([]));
  });

  it('rejects with Odrzuć', async () => {
    render(<FlowProposalCard view={view} />);
    fireEvent.click(screen.getByRole('button', { name: 'Odrzuć' }));
    await waitFor(() => expect(h.resolve).toHaveBeenCalledWith('ab12cd34', false));
    expect(h.resolve).toHaveBeenCalledTimes(1);
  });

  it('reports a failed decision and lets the user try again', async () => {
    h.resolve.mockRejectedValueOnce({ code: 'other', message: 'Propozycja wygasła' });
    h.list.mockResolvedValue([view]);
    render(<FlowProposalCard view={view} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zatwierdź' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Propozycja wygasła'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Zatwierdź' })).toBeEnabled());
    expect(h.list).toHaveBeenCalled();
  });
});
