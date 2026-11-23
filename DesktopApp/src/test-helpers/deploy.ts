import type { Tracking, TrackingView } from '../types';

export function makeTracking(overrides: Partial<Tracking> = {}): Tracking {
  return {
    id: 1,
    repoPath: '/repos/api',
    branch: 'main',
    commit: 'abcdef1234567890',
    state: 'building',
    ciBlocker: null,
    clusterBlocker: null,
    runId: null,
    runUrl: null,
    buildNumber: null,
    failure: null,
    baselineImages: null,
    baselineAt: null,
    currentImages: [],
    startedAt: 1_000,
    stageStartedAt: 1_000,
    buildFinishedAt: null,
    finishedAt: null,
    vpnAttempted: false,
    dismissed: false,
    hasBuild: true,
    hasDelivery: true,
    ...overrides,
  };
}

export function makeView(
  overrides: Partial<Tracking> = {},
  projectIds: number[] = [1],
  repoLabel = 'api',
): TrackingView {
  return { tracking: makeTracking(overrides), projectIds, repoLabel };
}
