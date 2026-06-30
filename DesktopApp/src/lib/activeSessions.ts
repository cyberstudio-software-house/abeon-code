import type { ActiveSession, Project, Provider, SessionActivity, SessionMeta } from '../types';
import { getProjectColor } from './projectColors';

export type ActiveSessionRow = {
  sessionId: string;
  projectId: number;
  projectName: string;
  title: string;
  activity: SessionActivity;
  lastModified: number;
  provider: Provider;
  color: string;
  attention: boolean;
};

type SessionsByProject = Record<number, { items: SessionMeta[]; hasMore: boolean }>;

function urgencyRank(row: ActiveSessionRow): number {
  if (row.attention) return 0;
  if (row.activity === 'waitingUser' || row.activity === 'waitingTool') return 1;
  if (row.activity === 'running') return 2;
  return 3;
}

export function buildActiveSessionRows(
  activeSessions: ActiveSession[],
  attentionSessions: Set<string>,
  sessionsByProject: SessionsByProject,
  projects: Project[],
): ActiveSessionRow[] {
  const projById = new Map(projects.map(p => [p.id, p]));
  const colorFor = (projectId: number) => {
    const p = projById.get(projectId);
    return p ? getProjectColor(p) : getProjectColor({ id: projectId, color: null });
  };
  const byId = new Map<string, ActiveSessionRow>();

  for (const s of activeSessions) {
    byId.set(s.sessionId, {
      sessionId: s.sessionId,
      projectId: s.projectId,
      projectName: s.projectName,
      title: s.title,
      activity: s.activity,
      lastModified: s.lastModified,
      provider: s.provider,
      color: colorFor(s.projectId),
      attention: attentionSessions.has(s.sessionId),
    });
  }

  for (const id of attentionSessions) {
    if (byId.has(id)) continue;
    for (const bucket of Object.values(sessionsByProject)) {
      const found = bucket.items.find(x => x.id === id);
      if (!found) continue;
      byId.set(id, {
        sessionId: found.id,
        projectId: found.projectId,
        projectName: projById.get(found.projectId)?.name ?? '',
        title: found.title,
        activity: found.activity,
        lastModified: found.lastModified,
        provider: found.provider,
        color: colorFor(found.projectId),
        attention: true,
      });
      break;
    }
  }

  return [...byId.values()].sort(
    (a, b) => urgencyRank(a) - urgencyRank(b) || b.lastModified - a.lastModified,
  );
}
