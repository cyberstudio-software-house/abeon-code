import { groupByProject, visibleSessions, isActiveSession } from '@/src/lib/roster';
import type { Session } from '@/src/store/sessionsSlice';
import type { SessionActivity } from '@/src/types/SessionActivity';

const mk = (id: string, projectName: string | null, at: number, activity: SessionActivity | null = null): Session =>
  ({ id, title: id, activity, usage: null, projectId: null, projectName, lastEventAt: at });

test('groupByProject buckets by project and sorts rows desc by lastEventAt', () => {
  const groups = groupByProject([mk('a', 'P1', 1), mk('b', 'P1', 5), mk('c', null, 9)]);
  expect(groups.map((g) => g.title)).toEqual(['Inne', 'P1']); // sections sorted by name, 'Inne' for null
  const p1 = groups.find((g) => g.title === 'P1')!;
  expect(p1.data.map((s) => s.id)).toEqual(['b', 'a']);       // 5 before 1
});

test('isActiveSession is true for any non-idle activity, false for idle/null', () => {
  expect(isActiveSession(mk('a', 'P', 1, 'running'))).toBe(true);
  expect(isActiveSession(mk('a', 'P', 1, 'waitingUser'))).toBe(true);
  expect(isActiveSession(mk('a', 'P', 1, 'idle'))).toBe(false);
  expect(isActiveSession(mk('a', 'P', 1, null))).toBe(false);
});

test('visibleSessions collapses idle to the limit but keeps every active session', () => {
  // 5 idle (sorted desc by caller) — collapsed shows only the first `limit`
  const idle = [mk('i1', 'P', 5, 'idle'), mk('i2', 'P', 4, 'idle'), mk('i3', 'P', 3, 'idle'), mk('i4', 'P', 2, 'idle'), mk('i5', 'P', 1, 'idle')];
  expect(visibleSessions(idle, false, 3).map((s) => s.id)).toEqual(['i1', 'i2', 'i3']);
  expect(visibleSessions(idle, true, 3).map((s) => s.id)).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']); // expanded → all

  // active sessions are never hidden, even beyond the limit
  const mixed = [mk('a1', 'P', 9, 'running'), mk('a2', 'P', 8, 'waitingUser'), mk('a3', 'P', 7, 'waitingTool'), mk('a4', 'P', 6, 'running'), mk('i1', 'P', 1, 'idle')];
  expect(visibleSessions(mixed, false, 3).map((s) => s.id)).toEqual(['a1', 'a2', 'a3', 'a4']); // all 4 active, no idle
});
