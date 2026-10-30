import type { SessionActivity } from '../types';
import type { IconName } from '../components/shared/Icon';

export const ACTIVITY_DOT: Record<SessionActivity, string> = {
  running:     'bg-accent',
  waitingUser: 'bg-info',
  waitingTool: 'bg-pink',
  idle:        'bg-muted',
};

export const ACTIVITY_LABEL: Record<SessionActivity, string> = {
  running:     'Aktywna — agent pracuje',
  waitingUser: 'Czeka na Twoją odpowiedź',
  waitingTool: 'Czeka na zatwierdzenie narzędzia',
  idle:        'Bezczynna',
};

export const ACTIVITY_TEXT: Record<SessionActivity, string> = {
  running:     'text-accent',
  waitingUser: 'text-info',
  waitingTool: 'text-pink',
  idle:        'text-muted',
};

export const ACTIVITY_ICON: Record<SessionActivity, IconName> = {
  running:     'spinner',
  waitingUser: 'bell',
  waitingTool: 'pause',
  idle:        'dot',
};

export const ACTIVITY_SHORT_LABEL: Record<SessionActivity, string> = {
  running:     'Pracuje',
  waitingUser: 'Czeka na Ciebie',
  waitingTool: 'Czeka na zgodę',
  idle:        'Bezczynna',
};

export function activityPulses(activity: SessionActivity): boolean {
  return activity === 'running';
}
