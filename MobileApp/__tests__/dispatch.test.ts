import { dispatchCommand } from '@/src/lib/dispatch';

jest.mock('@/src/lib/api', () => ({
  sendCommand: jest.fn().mockResolvedValue({ published: true }),
}));

import { sendCommand } from '@/src/lib/api';

test('dispatchCommand calls sendCommand with a valid envelope', async () => {
  await dispatchCommand('pt', { type: 'stopSession', sessionId: 's1' });

  expect(sendCommand).toHaveBeenCalledTimes(1);

  const [token, envelope] = (sendCommand as jest.Mock).mock.calls[0] as [string, { commandId: string; command: unknown }];
  expect(token).toBe('pt');
  expect(envelope.command).toEqual({ type: 'stopSession', sessionId: 's1' });
  expect(typeof envelope.commandId).toBe('string');
  expect(envelope.commandId.length).toBeGreaterThan(0);
});
