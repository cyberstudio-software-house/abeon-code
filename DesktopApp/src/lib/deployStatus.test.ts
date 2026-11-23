import { describe, expect, it } from 'vitest';
import { makeTracking, makeView } from '../test-helpers/deploy';
import {
  failureSummary,
  imageCarriesBuildNumber,
  openBlocker,
  pausedViews,
  projectTracking,
  stageLines,
  shownBlocker,
  singleLineForTerminal,
  trackingLabel,
  trackingPriority,
  trackingTone,
} from './deployStatus';

const TOOL_BLOCKER = { type: 'toolUnavailable' as const, tool: 'kubectl', reason: 'not logged in' };
const CLUSTER_BLOCKER = { type: 'clusterUnreachable' as const };

describe('trackingLabel and trackingTone', () => {
  it.each([
    ['waitingForRun', 'Czekam na pipeline', 'running'],
    ['building', 'Budowanie', 'running'],
    ['paused', 'Pipeline czeka na Ciebie', 'attention'],
    ['delivering', 'Wdrażanie na klaster', 'running'],
    ['succeeded', 'Wdrożono', 'done'],
    ['failed', 'Wdrożenie nie powiodło się', 'problem'],
    ['stalled', 'Nie widać dalszego ciągu', 'problem'],
    ['superseded', 'Zastąpione', 'muted'],
  ] as const)('maps %s', (state, label, tone) => {
    const tracking = makeTracking({ state });
    expect(trackingLabel(tracking)).toBe(label);
    expect(trackingTone(tracking)).toBe(tone);
  });

  it('lets a cluster blocker override the label of an open state', () => {
    const tracking = makeTracking({ state: 'building', ciBlocker: CLUSTER_BLOCKER });
    expect(trackingLabel(tracking)).toBe('Klaster niedostępny');
    expect(trackingTone(tracking)).toBe('problem');
  });

  it('lets a tool blocker override the label of an open state', () => {
    const tracking = makeTracking({ state: 'delivering', clusterBlocker: TOOL_BLOCKER });
    expect(trackingLabel(tracking)).toBe('Nie mogę sprawdzić');
    expect(trackingTone(tracking)).toBe('problem');
  });

  it.each([
    ['a cluster blocker', { clusterBlocker: CLUSTER_BLOCKER }],
    ['a CI tool blocker', { ciBlocker: TOOL_BLOCKER }],
  ])('keeps the paused label and tone with %s', (_name, blockers) => {
    const tracking = makeTracking({ state: 'paused', ...blockers });
    expect(trackingLabel(tracking)).toBe('Pipeline czeka na Ciebie');
    expect(trackingTone(tracking)).toBe('attention');
    expect(trackingPriority(tracking)).toBe(trackingPriority(makeTracking({ state: 'paused' })));
    expect(openBlocker(tracking)).not.toBeNull();
  });

  it('ignores a blocker on a closed tracking', () => {
    const tracking = makeTracking({ state: 'succeeded', ciBlocker: CLUSTER_BLOCKER });
    expect(trackingLabel(tracking)).toBe('Wdrożono');
    expect(trackingTone(tracking)).toBe('done');
  });
});

describe('shownBlocker', () => {
  it('prefers the cluster blocker while delivering', () => {
    const tracking = makeTracking({ state: 'delivering', ciBlocker: TOOL_BLOCKER, clusterBlocker: CLUSTER_BLOCKER });
    expect(shownBlocker(tracking)).toEqual(CLUSTER_BLOCKER);
  });

  it('prefers the CI blocker in every other state', () => {
    const tracking = makeTracking({ state: 'building', ciBlocker: TOOL_BLOCKER, clusterBlocker: CLUSTER_BLOCKER });
    expect(shownBlocker(tracking)).toEqual(TOOL_BLOCKER);
  });

  it('falls back to the other side and to null', () => {
    expect(shownBlocker(makeTracking({ state: 'delivering', ciBlocker: TOOL_BLOCKER }))).toEqual(TOOL_BLOCKER);
    expect(shownBlocker(makeTracking({ state: 'building' }))).toBeNull();
  });
});

describe('trackingPriority', () => {
  it('orders paused, failed, stalled, blocker, open, succeeded, superseded', () => {
    const order = [
      makeTracking({ state: 'paused' }),
      makeTracking({ state: 'failed' }),
      makeTracking({ state: 'stalled' }),
      makeTracking({ state: 'building', ciBlocker: CLUSTER_BLOCKER }),
      makeTracking({ state: 'delivering' }),
      makeTracking({ state: 'succeeded' }),
      makeTracking({ state: 'superseded' }),
    ].map(trackingPriority);
    expect([...order].sort((a, b) => b - a)).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
  });
});

describe('projectTracking', () => {
  it('returns null without a tracking of the project', () => {
    expect(projectTracking([makeView({}, [2])], 1)).toBeNull();
  });

  it('returns the paused view over a succeeded one with count 2', () => {
    const succeeded = makeView({ id: 1, state: 'succeeded', repoPath: '/a' });
    const paused = makeView({ id: 2, state: 'paused', repoPath: '/b' });
    const result = projectTracking([succeeded, paused], 1);
    expect(result?.top).toBe(paused);
    expect(result?.count).toBe(2);
  });

  it('shows a repository shared by two projects for both', () => {
    const shared = makeView({ id: 5 }, [1, 2]);
    expect(projectTracking([shared], 1)?.top).toBe(shared);
    expect(projectTracking([shared], 2)?.top).toBe(shared);
  });

  it('ignores dismissed views', () => {
    expect(projectTracking([makeView({ state: 'failed', dismissed: true })], 1)).toBeNull();
  });

  it('breaks a tie with the newer tracking', () => {
    const older = makeView({ id: 1, state: 'building', startedAt: 10 });
    const newer = makeView({ id: 2, state: 'building', startedAt: 20 });
    expect(projectTracking([older, newer], 1)?.top).toBe(newer);
  });
});

describe('pausedViews', () => {
  it('lists only paused, visible views of the project', () => {
    const paused = makeView({ id: 1, state: 'paused', repoPath: '/a' });
    const views = [
      paused,
      makeView({ id: 2, state: 'building', repoPath: '/b' }),
      makeView({ id: 3, state: 'paused', repoPath: '/c' }, [2]),
      makeView({ id: 4, state: 'paused', repoPath: '/d', dismissed: true }),
    ];
    expect(pausedViews(views, 1)).toEqual([paused]);
  });
});

describe('stageLines', () => {
  const at = (hours: number, minutes: number, day = new Date()) => {
    const date = new Date(day);
    date.setHours(hours, minutes, 0, 0);
    return date.getTime();
  };
  const NOW = at(15, 0);

  it('has no build line for a stall from waitingForRun', () => {
    const tracking = makeTracking({ state: 'stalled', startedAt: at(10, 0), finishedAt: at(11, 0), runId: null });
    expect(stageLines(tracking, NOW)).toEqual([]);
  });

  it('shows an ongoing build once a run was seen', () => {
    const tracking = makeTracking({ state: 'building', runId: '12', startedAt: at(10, 0) });
    expect(stageLines(tracking, NOW)).toEqual(['Budowanie: 10:00 – trwa']);
  });

  it('shows the build and an ongoing delivery', () => {
    const tracking = makeTracking({
      state: 'delivering', runId: '12', startedAt: at(10, 0), buildFinishedAt: at(10, 5),
    });
    expect(stageLines(tracking, NOW)).toEqual(['Budowanie: 10:00 – 10:05', 'Wdrażanie na klaster: 10:05 – trwa']);
  });

  it('shows a closed delivery that ran after the build', () => {
    const tracking = makeTracking({
      state: 'succeeded', runId: '12', startedAt: at(10, 0), buildFinishedAt: at(10, 5), finishedAt: at(10, 9),
    });
    expect(stageLines(tracking, NOW)).toEqual(['Budowanie: 10:00 – 10:05', 'Wdrażanie na klaster: 10:05 – 10:09']);
  });

  it('has no delivery line for a successful build-only tracking closed after the CI finish time', () => {
    const tracking = makeTracking({
      state: 'succeeded',
      hasDelivery: false,
      runId: '12',
      startedAt: at(10, 0),
      buildFinishedAt: at(10, 5),
      finishedAt: at(10, 6),
    });
    expect(stageLines(tracking, NOW)).toEqual(['Budowanie: 10:00 – 10:05']);
  });

  it('has no build line for a delivery-only tracking', () => {
    const delivering = makeTracking({
      state: 'delivering', hasBuild: false, startedAt: at(10, 0), buildFinishedAt: at(10, 0),
    });
    expect(stageLines(delivering, NOW)).toEqual(['Wdrażanie na klaster: 10:00 – trwa']);
    const done = makeTracking({
      state: 'succeeded', hasBuild: false, startedAt: at(10, 0), buildFinishedAt: at(10, 0), finishedAt: at(10, 4),
    });
    expect(stageLines(done, NOW)).toEqual(['Wdrażanie na klaster: 10:00 – 10:04']);
  });

  it('has no build line while no run was seen and the build has not finished', () => {
    const tracking = makeTracking({ state: 'waitingForRun', startedAt: at(10, 0) });
    expect(stageLines(tracking, NOW)).toEqual([]);
  });

  it('has no delivery line for a build failure that closed after the build ended', () => {
    const tracking = makeTracking({
      state: 'failed',
      runId: '12',
      startedAt: at(10, 0),
      buildFinishedAt: at(10, 5),
      finishedAt: at(10, 6),
      failure: { stage: 'build', reason: 'tests', logExcerpt: null },
    });
    expect(stageLines(tracking, NOW)).toEqual(['Budowanie: 10:00 – 10:05']);
  });

  it('closes an unfinished build line at the end of a stalled tracking', () => {
    const tracking = makeTracking({ state: 'stalled', runId: '12', startedAt: at(10, 0), finishedAt: at(12, 0) });
    expect(stageLines(tracking, NOW)).toEqual(['Budowanie: 10:00 – 12:00']);
  });

  it('adds the date to every time of a tracking that did not start today', () => {
    const yesterday = new Date(NOW - 36 * 3_600_000);
    const day = String(yesterday.getDate()).padStart(2, '0');
    const month = String(yesterday.getMonth() + 1).padStart(2, '0');
    const tracking = makeTracking({
      state: 'delivering', runId: '12', startedAt: at(10, 0, yesterday), buildFinishedAt: at(10, 5, yesterday),
    });
    expect(stageLines(tracking, NOW)).toEqual([
      `Budowanie: ${day}.${month} 10:00 – ${day}.${month} 10:05`,
      `Wdrażanie na klaster: ${day}.${month} 10:05 – trwa`,
    ]);
  });
});

describe('imageCarriesBuildNumber', () => {
  it('matches a dot or colon suffix', () => {
    expect(imageCarriesBuildNumber(makeTracking({ buildNumber: 42, currentImages: ['reg/app:1.42'] }))).toBe(true);
    expect(imageCarriesBuildNumber(makeTracking({ buildNumber: 42, currentImages: ['reg/app:42'] }))).toBe(true);
  });

  it('does not match a longer number or no number', () => {
    expect(imageCarriesBuildNumber(makeTracking({ buildNumber: 2, currentImages: ['reg/app:1.42'] }))).toBe(false);
    expect(imageCarriesBuildNumber(makeTracking({ buildNumber: null, currentImages: ['reg/app:1.42'] }))).toBe(false);
  });
});

describe('failureSummary', () => {
  it('names the short commit, the stage word and the excerpt', () => {
    const tracking = makeTracking({
      state: 'failed',
      failure: { stage: 'build', reason: 'tests failed', logExcerpt: 'line 1\nline 2' },
    });
    expect(failureSummary(tracking)).toBe('Wdrożenie abcdef1 nie powiodło się na etapie budowania: tests failed\n\nline 1\nline 2');
  });

  it('uses the delivery stage word and omits a missing excerpt', () => {
    const tracking = makeTracking({
      state: 'failed',
      failure: { stage: 'delivery', reason: 'rollout timed out', logExcerpt: null },
    });
    expect(failureSummary(tracking)).toBe('Wdrożenie abcdef1 nie powiodło się na etapie wdrażania na klaster: rollout timed out');
  });

  it('is null without a failure', () => {
    expect(failureSummary(makeTracking())).toBeNull();
  });
});

describe('singleLineForTerminal', () => {
  it('collapses lines into one and cannot contain a newline or carriage return', () => {
    const result = singleLineForTerminal('a\r\nb\n\nc\rd');
    expect(result).toBe('a b c d');
  });

  it('strips escape and other control characters', () => {
    expect(singleLineForTerminal('x\u001b[31my\u0007z\u0085\u007f')).toBe('x[31myz');
  });

  it('turns a tab into a space', () => {
    expect(singleLineForTerminal('a\tb')).toBe('a b');
  });
});
