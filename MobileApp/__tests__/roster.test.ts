import { groupByProject } from '@/src/lib/roster';
import type { Session } from '@/src/store/sessionsSlice';

const mk = (id: string, projectName: string | null, at: number): Session =>
  ({ id, title: id, activity: null, usage: null, projectId: null, projectName, lastEventAt: at });

test('groupByProject buckets by project and sorts rows desc by lastEventAt', () => {
  const groups = groupByProject([mk('a', 'P1', 1), mk('b', 'P1', 5), mk('c', null, 9)]);
  expect(groups.map((g) => g.title)).toEqual(['Inne', 'P1']); // sections sorted by name, 'Inne' for null
  const p1 = groups.find((g) => g.title === 'P1')!;
  expect(p1.data.map((s) => s.id)).toEqual(['b', 'a']);       // 5 before 1
});
