import { applyHistoryPage } from '@/src/lib/centrifugo';

test('routes each parseable publication through onEvent in order', () => {
  const seen: string[] = [];
  applyHistoryPage(
    [
      { data: { type: 'sessionTitle', sessionId: 's1', title: 'A' } },
      { data: { type: 'nope' } },
      { data: { type: 'sessionActivity', sessionId: 's1', activity: 'running' } },
    ],
    (e) => seen.push(e.type),
  );
  expect(seen).toEqual(['sessionTitle', 'sessionActivity']);
});

test('tolerates empty/garbage publications', () => {
  const seen: unknown[] = [];
  applyHistoryPage([{ data: null }, {}], (e) => seen.push(e));
  expect(seen).toEqual([]);
});
