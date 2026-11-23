import type { Blocker, Tracking, TrackingView } from '../types';

export type DeployTone = 'running' | 'attention' | 'problem' | 'done' | 'muted';

const OPEN_STATES: ReadonlySet<Tracking['state']> = new Set(['waitingForRun', 'building', 'paused', 'delivering']);

const STATE_LABEL: Record<Tracking['state'], string> = {
  waitingForRun: 'Czekam na pipeline',
  building: 'Budowanie',
  paused: 'Pipeline czeka na Ciebie',
  delivering: 'Wdrażanie na klaster',
  succeeded: 'Wdrożono',
  failed: 'Wdrożenie nie powiodło się',
  stalled: 'Nie widać dalszego ciągu',
  superseded: 'Zastąpione',
};

const STATE_TONE: Record<Tracking['state'], DeployTone> = {
  waitingForRun: 'running',
  building: 'running',
  paused: 'attention',
  delivering: 'running',
  succeeded: 'done',
  failed: 'problem',
  stalled: 'problem',
  superseded: 'muted',
};

const STATE_PRIORITY: Record<Tracking['state'], number> = {
  paused: 100,
  failed: 90,
  stalled: 80,
  waitingForRun: 50,
  building: 50,
  delivering: 50,
  succeeded: 20,
  superseded: 10,
};

const BLOCKER_PRIORITY = 70;

const BLOCKER_LABEL: Record<Blocker['type'], string> = {
  clusterUnreachable: 'Klaster niedostępny',
  toolUnavailable: 'Nie mogę sprawdzić',
};

export function isOpenTracking(tracking: Tracking): boolean {
  return OPEN_STATES.has(tracking.state);
}

export function shownBlocker(tracking: Tracking): Blocker | null {
  if (tracking.state === 'delivering') return tracking.clusterBlocker ?? tracking.ciBlocker;
  return tracking.ciBlocker ?? tracking.clusterBlocker;
}

function openBlocker(tracking: Tracking): Blocker | null {
  return isOpenTracking(tracking) ? shownBlocker(tracking) : null;
}

export function trackingTone(tracking: Tracking): DeployTone {
  return openBlocker(tracking) ? 'problem' : STATE_TONE[tracking.state];
}

export function trackingLabel(tracking: Tracking): string {
  const blocker = openBlocker(tracking);
  return blocker ? BLOCKER_LABEL[blocker.type] : STATE_LABEL[tracking.state];
}

export function trackingPriority(tracking: Tracking): number {
  if (tracking.state === 'paused' || !isOpenTracking(tracking)) return STATE_PRIORITY[tracking.state];
  return openBlocker(tracking) ? BLOCKER_PRIORITY : STATE_PRIORITY[tracking.state];
}

export function compareViewsByNeed(a: TrackingView, b: TrackingView): number {
  return (
    trackingPriority(b.tracking) - trackingPriority(a.tracking)
    || b.tracking.startedAt - a.tracking.startedAt
    || b.tracking.id - a.tracking.id
  );
}

export function visibleViews(views: TrackingView[], projectId: number): TrackingView[] {
  return views
    .filter(view => view.projectIds.includes(projectId) && !view.tracking.dismissed)
    .sort(compareViewsByNeed);
}

export function projectTracking(
  views: TrackingView[],
  projectId: number,
): { top: TrackingView; count: number } | null {
  const own = visibleViews(views, projectId);
  return own.length === 0 ? null : { top: own[0], count: own.length };
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

export function stageWord(stage: 'build' | 'delivery'): string {
  return stage === 'build' ? 'budowania' : 'wdrażania na klaster';
}

export function imageCarriesBuildNumber(tracking: Tracking): boolean {
  const number = tracking.buildNumber;
  if (number === null) return false;
  return tracking.currentImages.some(image => image.endsWith(`.${number}`) || image.endsWith(`:${number}`));
}

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;

export function singleLineForTerminal(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map(line => line.replace(/\t/g, ' ').replace(CONTROL_CHARACTERS, '').trim())
    .filter(line => line.length > 0)
    .join(' ');
}

export function failureSummary(tracking: Tracking): string | null {
  const failure = tracking.failure;
  if (!failure) return null;
  const head = `Wdrożenie ${shortCommit(tracking.commit)} nie powiodło się na etapie ${stageWord(failure.stage)}: ${failure.reason}`;
  return failure.logExcerpt ? `${head}\n\n${failure.logExcerpt}` : head;
}
