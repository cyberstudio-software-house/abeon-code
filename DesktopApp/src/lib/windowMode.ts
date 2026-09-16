import type { Provider } from '../types';
import { isProvider } from './providers';

export type DetachedTab =
  | { kind: 'session'; id: string; sessionId: string; linkedSessionId?: string; title: string; mode: 'history' | 'terminal'; fresh?: boolean; preview?: boolean; provider?: Provider }
  | { kind: 'action'; id: string; actionId: number; title: string; status: 'running' | 'exited'; exitCode?: number; ptyId?: string }
  | { kind: 'terminal'; id: string; title: string }
  | { kind: 'providerPicker'; id: string; title: string };

export type SessionWindowMode = {
  view: 'session';
  projectId: number;
  sessionId: string;
  linkedSessionId?: string;
  title: string;
  fresh: boolean;
  provider?: Provider;
};

export type GroupWindowMode = {
  view: 'group';
  projectId: number;
  tabs: DetachedTab[];
  activeTabId: string | null;
};

export type NotesWindowMode = { view: 'notes'; projectId: number };

export type WindowMode = SessionWindowMode | GroupWindowMode | NotesWindowMode;

function encodePayload(value: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

function decodePayload(raw: string): unknown {
  return JSON.parse(decodeURIComponent(escape(atob(raw))));
}

function parseProjectId(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

function parseSessionMode(q: URLSearchParams): SessionWindowMode | null {
  const projectId = parseProjectId(q.get('projectId'));
  const sessionId = q.get('sessionId');
  if (projectId === null || !sessionId) return null;
  const linkedSessionId = q.get('linkedSessionId') ?? undefined;
  const title = q.get('title') ?? 'Sesja';
  const fresh = q.get('fresh') === 'true';
  const rawProvider = q.get('provider');
  const provider = isProvider(rawProvider) ? rawProvider : undefined;
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

function parseGroupMode(q: URLSearchParams): GroupWindowMode | null {
  const projectId = parseProjectId(q.get('projectId'));
  const raw = q.get('tabs');
  if (projectId === null || !raw) return null;
  let tabs: unknown;
  try {
    tabs = decodePayload(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  return {
    view: 'group',
    projectId,
    tabs: tabs as DetachedTab[],
    activeTabId: q.get('activeTabId'),
  };
}

function parseNotesMode(q: URLSearchParams): NotesWindowMode | null {
  const projectId = parseProjectId(q.get('projectId'));
  return projectId === null ? null : { view: 'notes', projectId };
}

export function parseWindowMode(search: string): WindowMode | null {
  const q = new URLSearchParams(search);
  const view = q.get('view');
  if (view === 'session') return parseSessionMode(q);
  if (view === 'group') return parseGroupMode(q);
  if (view === 'notes') return parseNotesMode(q);
  return null;
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

export function buildGroupWindowUrl(p: {
  projectId: number;
  tabs: DetachedTab[];
  activeTabId: string | null;
}): string {
  const q = new URLSearchParams();
  q.set('view', 'group');
  q.set('projectId', String(p.projectId));
  q.set('tabs', encodePayload(p.tabs));
  if (p.activeTabId) q.set('activeTabId', p.activeTabId);
  return `index.html?${q.toString()}`;
}

export function buildNotesWindowUrl(projectId: number): string {
  const q = new URLSearchParams({ view: 'notes', projectId: String(projectId) });
  return `index.html?${q.toString()}`;
}

export function sessionWindowLabel(sessionId: string): string {
  return `session-${sessionId.replace(/[^a-zA-Z0-9-]/g, '_')}`;
}

export function groupWindowLabel(projectId: number): string {
  return `project-${projectId}`;
}

export function notesWindowLabel(projectId: number): string {
  return `notes-project-${projectId}`;
}
