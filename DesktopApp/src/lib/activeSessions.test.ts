import { describe, it, expect } from 'vitest';
import { buildActiveSessionRows } from './activeSessions';
import type { ActiveSession, Project, SessionMeta } from '../types';

function active(id: string, activity: ActiveSession['activity'], lastModified: number): ActiveSession {
  return { sessionId: id, projectId: 1, projectName: 'Proj', title: `T-${id}`, activity, lastModified, provider: 'claude' };
}
function project(id: number, color: string | null): Project {
  return { id, name: `P${id}`, path: `/p${id}`, claudeDir: `d${id}`, color, sortOrder: 0, createdAt: 0 };
}
function sessionMeta(id: string, projectId: number, activity: SessionMeta['activity']): SessionMeta {
  return { id, projectId, title: `S-${id}`, messageCount: 1, lastModified: 9, gitBranch: null, cwd: null, activity, provider: 'codex' };
}

describe('buildActiveSessionRows', () => {
  it('sorts waiting before running, and by recency within a tier', () => {
    const rows = buildActiveSessionRows(
      [active('run-old', 'running', 100), active('wait', 'waitingUser', 50), active('run-new', 'running', 300)],
      new Set(),
      {},
      [project(1, '#abcdef')],
      new Set(['run-old', 'wait', 'run-new']),
    );
    expect(rows.map(r => r.sessionId)).toEqual(['wait', 'run-new', 'run-old']);
  });

  it('marks attention rows, floats them to the top, and dedupes', () => {
    const rows = buildActiveSessionRows(
      [active('a', 'running', 100)],
      new Set(['a']),
      {},
      [project(1, '#abcdef')],
      new Set(['a']),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attention).toBe(true);
  });

  it('attaches the project color', () => {
    const rows = buildActiveSessionRows([active('a', 'running', 1)], new Set(), {}, [project(1, '#123456')], new Set(['a']));
    expect(rows[0].color).toBe('#123456');
  });

  it('includes an attention-only session resolved from sessionsByProject', () => {
    const rows = buildActiveSessionRows(
      [],
      new Set(['z']),
      { 1: { items: [sessionMeta('z', 1, 'idle')], hasMore: false } },
      [project(1, null)],
      new Set(['z']),
    );
    expect(rows.map(r => r.sessionId)).toEqual(['z']);
    expect(rows[0].attention).toBe(true);
    expect(rows[0].provider).toBe('codex');
  });

  it('excludes sessions without an open tab, even waiting/attention ones', () => {
    const rows = buildActiveSessionRows(
      [active('a', 'waitingUser', 100)],
      new Set(['a']),
      {},
      [project(1, '#abcdef')],
      new Set(),
    );
    expect(rows).toEqual([]);
  });

  it('keeps only the open-tab subset when some sessions are open and others are not', () => {
    const rows = buildActiveSessionRows(
      [active('open', 'running', 100), active('closed', 'waitingUser', 200)],
      new Set(),
      {},
      [project(1, '#abcdef')],
      new Set(['open']),
    );
    expect(rows.map(r => r.sessionId)).toEqual(['open']);
  });
});
