import type { SessionActivity } from '../types';
import type { IconName } from '../components/shared/Icon';

export const ACTIVITY_DOT: Record<SessionActivity, string> = {
  running:     'bg-success',
  waitingUser: 'bg-accent',
  waitingTool: 'bg-warn',
  idle:        'bg-muted',
};

export const ACTIVITY_LABEL: Record<SessionActivity, string> = {
  running:     'Aktywna — agent pracuje',
  waitingUser: 'Czeka na Twoją odpowiedź',
  waitingTool: 'Czeka na zatwierdzenie narzędzia',
  idle:        'Bezczynna',
};

export const ACTIVITY_TEXT: Record<SessionActivity, string> = {
  running:     'text-success',
  waitingUser: 'text-accent',
  waitingTool: 'text-warn',
  idle:        'text-muted',
};

export const ACTIVITY_ICON: Record<SessionActivity, IconName> = {
  running:     'spinner',
  waitingUser: 'bell',
  waitingTool: 'pause',
  idle:        'dot',
};
