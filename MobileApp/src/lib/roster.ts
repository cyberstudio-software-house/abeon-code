import type { Session } from '@/src/store/sessionsSlice';

export interface SessionSection { title: string; data: Session[]; }

const UNGROUPED = 'Inne';

export function groupByProject(sessions: Session[]): SessionSection[] {
  const buckets = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.projectName ?? UNGROUPED;
    const arr = buckets.get(key) ?? [];
    arr.push(s);
    buckets.set(key, arr);
  }
  return [...buckets.entries()]
    .map(([title, data]) => ({ title, data: [...data].sort((a, b) => b.lastEventAt - a.lastEventAt) }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
