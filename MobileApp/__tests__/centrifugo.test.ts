import { parseSessionEvent, parseDeviceEvent } from '@/src/lib/centrifugo';

test('parses a sessionAppend publication into a typed event', () => {
  const ev = parseSessionEvent({ type: 'sessionAppend', sessionId: 's1', blocks: [{ kind: 'userText', uuid: 'u', timestamp: 1, text: 'hi' }] });
  expect(ev).toEqual({ type: 'sessionAppend', sessionId: 's1', blocks: [{ kind: 'userText', uuid: 'u', timestamp: 1, text: 'hi' }] });
});

test('parses sessionActivity', () => {
  expect(parseSessionEvent({ type: 'sessionActivity', sessionId: 's1', activity: 'waitingUser' }))
    .toEqual({ type: 'sessionActivity', sessionId: 's1', activity: 'waitingUser' });
});

test('returns null for an unknown session event type', () => {
  expect(parseSessionEvent({ type: 'somethingElse' })).toBeNull();
});

test('parses a cmdResult device event', () => {
  expect(parseDeviceEvent({ type: 'cmdResult', commandId: 'c1', ok: true }))
    .toEqual({ type: 'cmdResult', commandId: 'c1', ok: true });
});
