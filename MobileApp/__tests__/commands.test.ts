import { buildEnvelope } from '@/src/lib/commands';

test('builds a sendPrompt envelope with a command id', () => {
  const env = buildEnvelope({ type: 'sendPrompt', sessionId: 's1', text: 'go' }, () => 'cid-1');
  expect(env).toEqual({ commandId: 'cid-1', command: { type: 'sendPrompt', sessionId: 's1', text: 'go' } });
});

test('builds an approvePermission envelope', () => {
  const env = buildEnvelope({ type: 'approvePermission', sessionId: 's1' }, () => 'cid-2');
  expect(env.command).toEqual({ type: 'approvePermission', sessionId: 's1' });
  expect(env.commandId).toBe('cid-2');
});
