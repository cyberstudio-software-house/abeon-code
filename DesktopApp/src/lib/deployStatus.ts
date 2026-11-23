import type { Blocker, Tracking, TrackingView } from '../types';
import { formatClock } from './formatClock';

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

export function openBlocker(tracking: Tracking): Blocker | null {
  return isOpenTracking(tracking) ? shownBlocker(tracking) : null;
}

function labelBlocker(tracking: Tracking): Blocker | null {
  return tracking.state === 'paused' ? null : openBlocker(tracking);
}

export const TONE_DOT: Record<DeployTone, string> = {
  running: 'bg-accent activity-pulse',
  attention: 'bg-accent',
  problem: 'bg-danger',
  done: 'bg-success',
  muted: 'bg-muted',
};

export function trackingTone(tracking: Tracking): DeployTone {
  return labelBlocker(tracking) ? 'problem' : STATE_TONE[tracking.state];
}

export function trackingLabel(tracking: Tracking): string {
  const blocker = labelBlocker(tracking);
  return blocker ? BLOCKER_LABEL[blocker.type] : STATE_LABEL[tracking.state];
}

export function trackingPriority(tracking: Tracking): number {
  return labelBlocker(tracking) ? BLOCKER_PRIORITY : STATE_PRIORITY[tracking.state];
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

export function pausedViews(views: TrackingView[], projectId: number): TrackingView[] {
  return visibleViews(views, projectId).filter(view => view.tracking.state === 'paused');
}

export function hasPausedView(views: TrackingView[], projectId: number): boolean {
  return views.some(view =>
    view.projectIds.includes(projectId) && !view.tracking.dismissed && view.tracking.state === 'paused');
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

const pad = (value: number) => String(value).padStart(2, '0');

function sameDay(first: Date, second: Date): boolean {
  return first.getFullYear() === second.getFullYear()
    && first.getMonth() === second.getMonth()
    && first.getDate() === second.getDate();
}

function stageTime(timestamp: number, withDate: boolean): string {
  const date = new Date(timestamp);
  const clock = formatClock(timestamp);
  return withDate ? `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${clock}` : clock;
}

function stageRange(start: number, end: number | null, ongoing: boolean, withDate: boolean): string {
  const from = stageTime(start, withDate);
  if (end !== null) return `${from} – ${stageTime(end, withDate)}`;
  return `${from} – ${ongoing ? 'trwa' : '—'}`;
}

function reachedDelivery(tracking: Tracking): boolean {
  if (!tracking.hasDelivery || tracking.buildFinishedAt === null) return false;
  if (tracking.state === 'delivering') return true;
  if (isOpenTracking(tracking)) return false;
  return tracking.failure?.stage !== 'build';
}

export function stageLines(tracking: Tracking, now: number = Date.now()): string[] {
  const open = isOpenTracking(tracking);
  const withDate = !sameDay(new Date(tracking.startedAt), new Date(now));
  const lines: string[] = [];
  if (tracking.hasBuild && (tracking.runId !== null || tracking.buildFinishedAt !== null)) {
    const buildEnd = tracking.buildFinishedAt ?? (open ? null : tracking.finishedAt);
    lines.push(`Budowanie: ${stageRange(tracking.startedAt, buildEnd, open, withDate)}`);
  }
  if (tracking.buildFinishedAt !== null && reachedDelivery(tracking)) {
    lines.push(`Wdrażanie na klaster: ${stageRange(tracking.buildFinishedAt, open ? null : tracking.finishedAt, open, withDate)}`);
  }
  return lines;
}

export function failureSummary(tracking: Tracking): string | null {
  const failure = tracking.failure;
  if (!failure) return null;
  const head = `Wdrożenie ${shortCommit(tracking.commit)} nie powiodło się na etapie ${stageWord(failure.stage)}: ${failure.reason}`;
  return failure.logExcerpt ? `${head}\n\n${failure.logExcerpt}` : head;
}
