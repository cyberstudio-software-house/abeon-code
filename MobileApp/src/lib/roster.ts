import type { Session } from '@/src/store/sessionsSlice';

export interface SessionSection { title: string; data: Session[]; }

const UNGROUPED = 'Inne';

/** How many sessions a project section shows before "Pokaż wszystkie". */
export const COLLAPSED_LIMIT = 3;

/** A session is "active" (worth surfacing) when it is not idle. */
export function isActiveSession(s: Session): boolean {
  return s.activity != null && s.activity !== 'idle';
}

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

// Which sessions to render when a section is collapsed. Active sessions are ALWAYS kept
// (they're the ones you act on); the remaining slots up to `limit` are filled with the
// most-recent idle ones. `data` is assumed sorted most-recent-first (groupByProject does
// this). Expanded → everything. Tune `limit`/this rule to change the collapsed view.
export function visibleSessions(data: Session[], expanded: boolean, limit = COLLAPSED_LIMIT): Session[] {
  if (expanded) return data;
  const active = data.filter(isActiveSession);
  if (active.length >= limit) return active;
  const idle = data.filter((s) => !isActiveSession(s));
  return [...active, ...idle.slice(0, limit - active.length)];
}
