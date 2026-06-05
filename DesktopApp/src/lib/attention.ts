import type { AttentionReason } from './tauri';

export type NotificationTrigger = 'turnEnd' | 'questionsOnly' | 'both';

export function triggerMatches(trigger: NotificationTrigger, reason: AttentionReason): boolean {
  if (trigger === 'both') return true;
  if (trigger === 'turnEnd') return reason === 'heuristic';
  return reason === 'hook';
}

export function shouldNotify(args: {
  enabled: boolean;
  trigger: NotificationTrigger;
  reason: AttentionReason;
  isActiveFocused: boolean;
}): boolean {
  const { enabled, trigger, reason, isActiveFocused } = args;
  if (!enabled) return false;
  if (isActiveFocused) return false;
  return triggerMatches(trigger, reason);
}
