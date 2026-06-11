import type { Provider } from '../types';

export type WindowMode = {
  view: 'session';
  projectId: number;
  sessionId: string;
  linkedSessionId?: string;
  title: string;
  fresh: boolean;
  provider?: Provider;
};

export function parseWindowMode(search: string): WindowMode | null {
  const q = new URLSearchParams(search);
  if (q.get('view') !== 'session') return null;
  const projectIdRaw = q.get('projectId');
  const sessionId = q.get('sessionId');
  if (!projectIdRaw || !sessionId) return null;
  const projectId = Number(projectIdRaw);
  if (!Number.isInteger(projectId)) return null;
  const linkedSessionId = q.get('linkedSessionId') ?? undefined;
  const title = q.get('title') ?? 'Sesja';
  const fresh = q.get('fresh') === 'true';
  const provider: Provider | undefined = q.get('provider') === 'codex' ? 'codex' : undefined;
  return {
    view: 'session',
    projectId,
    sessionId,
    ...(linkedSessionId ? { linkedSessionId } : {}),
    title,
    fresh,
    ...(provider ? { provider } : {}),
  };
}

export function buildSessionWindowUrl(p: {
  projectId: number;
  sessionId: string;
  linkedSessionId?: string;
  title: string;
  fresh: boolean;
  provider?: Provider;
}): string {
  const q = new URLSearchParams();
  q.set('view', 'session');
  q.set('projectId', String(p.projectId));
  q.set('sessionId', p.sessionId);
  if (p.linkedSessionId) q.set('linkedSessionId', p.linkedSessionId);
  q.set('title', p.title);
  q.set('fresh', p.fresh ? 'true' : 'false');
  if (p.provider) q.set('provider', p.provider);
  return `index.html?${q.toString()}`;
}

export function sessionWindowLabel(sessionId: string): string {
  return `session-${sessionId.replace(/[^a-zA-Z0-9-]/g, '_')}`;
}
