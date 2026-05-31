import { createStore } from '@/src/store';

test('applySessionEvent(sessionTitle) upserts a session with the title', () => {
  const s = createStore();
  s.getState().applySessionEvent({ type: 'sessionTitle', sessionId: 's1', title: 'Refaktor' });
  expect(s.getState().sessions.get('s1')?.title).toBe('Refaktor');
});

test('applySessionEvent(sessionActivity) updates status', () => {
  const s = createStore();
  s.getState().applySessionEvent({ type: 'sessionActivity', sessionId: 's1', activity: 'waitingUser' });
  expect(s.getState().sessions.get('s1')?.activity).toBe('waitingUser');
});

test('applySessionEvent(sessionAppend) appends history blocks in order', () => {
  const s = createStore();
  s.getState().applySessionEvent({ type: 'sessionAppend', sessionId: 's1', blocks: [{ kind: 'userText', uuid: 'a', timestamp: 1, text: 'x' }] });
  s.getState().applySessionEvent({ type: 'sessionAppend', sessionId: 's1', blocks: [{ kind: 'assistantText', uuid: 'b', timestamp: 2, text: 'y' }] });
  expect(s.getState().history.get('s1')?.map((b) => b.uuid)).toEqual(['a', 'b']);
});

test('applySessionEvent(sessionUsage) stores the summary', () => {
  const s = createStore();
  const summary = { tokens: { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 }, costUsd: 0.1, byModel: [], unknownModels: [] };
  s.getState().applySessionEvent({ type: 'sessionUsage', sessionId: 's1', summary });
  expect(s.getState().sessions.get('s1')?.usage?.costUsd).toBe(0.1);
});

test('append de-dupes by block uuid (history replay safe)', () => {
  const s = createStore();
  const blk = { kind: 'userText', uuid: 'a', timestamp: 1, text: 'x' } as const;
  s.getState().applySessionEvent({ type: 'sessionAppend', sessionId: 's1', blocks: [blk] });
  s.getState().applySessionEvent({ type: 'sessionAppend', sessionId: 's1', blocks: [blk] });
  expect(s.getState().history.get('s1')?.length).toBe(1);
});
