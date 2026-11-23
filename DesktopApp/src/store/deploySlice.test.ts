import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from './index';
import { tauri } from '../lib/tauri';
import { makeView } from '../test-helpers/deploy';
import type { ProposalView, RepoFlow, TrackingView } from '../types';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('deploySlice loadTrackings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useStore.setState({ trackings: [] });
  });

  it('stores the loaded trackings', async () => {
    const views = [makeView({ id: 1 })];
    vi.spyOn(tauri, 'deployListTrackings').mockResolvedValue(views);
    await useStore.getState().loadTrackings();
    expect(useStore.getState().trackings).toEqual(views);
  });

  it('does not let an older response overwrite a newer one', async () => {
    const older = deferred<TrackingView[]>();
    const newer = deferred<TrackingView[]>();
    vi.spyOn(tauri, 'deployListTrackings')
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const newerViews = [makeView({ id: 2, state: 'succeeded' })];

    const first = useStore.getState().loadTrackings();
    const second = useStore.getState().loadTrackings();
    newer.resolve(newerViews);
    await second;
    older.resolve([makeView({ id: 1, state: 'building' })]);
    await first;

    expect(useStore.getState().trackings).toEqual(newerViews);
  });
});

function proposalView(id: string): ProposalView {
  return {
    proposal: {
      id,
      repoPath: '/repos/api',
      flow: {
        repoPath: '/repos/api',
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
      },
      createdAt: 1,
      expiresAt: 2,
    },
    repoLabel: 'api',
    projectIds: [1],
    changes: [],
  };
}

describe('deploySlice proposals', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useStore.setState({ proposals: [] });
  });

  it('does not let an older proposal list overwrite a newer one', async () => {
    const older = deferred<ProposalView[]>();
    const newer = deferred<ProposalView[]>();
    vi.spyOn(tauri, 'deployListProposals')
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const first = useStore.getState().loadProposals();
    const second = useStore.getState().loadProposals();
    newer.resolve([]);
    await second;
    older.resolve([proposalView('aaaaaaaa')]);
    await first;

    expect(useStore.getState().proposals).toEqual([]);
  });

  it('drops a resolved proposal at once and ignores a list loaded before the decision', async () => {
    const stale = deferred<ProposalView[]>();
    vi.spyOn(tauri, 'deployListProposals')
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([proposalView('bbbbbbbb')]);
    const resolve = vi.spyOn(tauri, 'deployResolveProposal').mockResolvedValue(undefined);
    useStore.setState({ proposals: [proposalView('aaaaaaaa'), proposalView('bbbbbbbb')] });

    const loading = useStore.getState().loadProposals();
    await useStore.getState().resolveProposal('aaaaaaaa', true);
    stale.resolve([proposalView('aaaaaaaa'), proposalView('bbbbbbbb')]);
    await loading;

    expect(resolve).toHaveBeenCalledWith('aaaaaaaa', true);
    expect(useStore.getState().proposals.map(view => view.proposal.id)).toEqual(['bbbbbbbb']);
  });

  it('reloads the proposals and rethrows when a decision fails', async () => {
    vi.spyOn(tauri, 'deployResolveProposal').mockRejectedValue({ message: 'Propozycja wygasła' });
    const list = vi.spyOn(tauri, 'deployListProposals').mockResolvedValue([]);
    useStore.setState({ proposals: [proposalView('aaaaaaaa')] });

    await expect(useStore.getState().resolveProposal('aaaaaaaa', false)).rejects.toEqual({
      message: 'Propozycja wygasła',
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(useStore.getState().proposals).toEqual([]);
  });
});

describe('deploySlice loadRepoFlows', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useStore.setState({ repoFlowsByProject: {} });
  });

  it('does not let an older list of a project overwrite a newer one', async () => {
    const older = deferred<RepoFlow[]>();
    const newer = deferred<RepoFlow[]>();
    vi.spyOn(tauri, 'deployListRepoFlows')
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const repo = (flow: RepoFlow['flow']): RepoFlow => ({
      repoPath: '/repos/api',
      label: 'api',
      remotes: ['origin'],
      flow,
      proposal: null,
    });
    const fresh = [repo(proposalView('aaaaaaaa').proposal.flow)];

    const first = useStore.getState().loadRepoFlows(1);
    const second = useStore.getState().loadRepoFlows(1);
    newer.resolve(fresh);
    await second;
    older.resolve([repo(null)]);
    await first;

    expect(useStore.getState().repoFlowsByProject[1]).toEqual(fresh);
  });
});
