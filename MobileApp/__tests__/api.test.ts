import { claimPairing, fetchToken, sendCommand } from '@/src/lib/api';
import type { RemoteEnvelope } from '@/src/types/RemoteEnvelope';

const okJson = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) } as Response);

afterEach(() => { (global.fetch as jest.Mock)?.mockReset?.(); });

test('claimPairing posts the code and returns phoneToken + deviceId', async () => {
  global.fetch = jest.fn(() => okJson({ phoneToken: 'pt_1', deviceId: 'dev_1' })) as unknown as typeof fetch;
  const res = await claimPairing('ABCD-1234');
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toContain('/v1/pair/claim');
  expect(JSON.parse(init.body)).toEqual({ code: 'ABCD-1234' });
  expect(res).toEqual({ phoneToken: 'pt_1', deviceId: 'dev_1' });
});

test('fetchToken sends Bearer phoneToken and returns the JWT', async () => {
  global.fetch = jest.fn(() => okJson({ token: 'jwt_x', expiresInSecs: 3600 })) as unknown as typeof fetch;
  const res = await fetchToken('pt_1');
  const [, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(init.headers.Authorization).toBe('Bearer pt_1');
  expect(res).toEqual({ token: 'jwt_x', expiresInSecs: 3600 });
});

test('sendCommand posts the envelope with Bearer auth', async () => {
  global.fetch = jest.fn(() => okJson({ published: true }, 202)) as unknown as typeof fetch;
  const env: RemoteEnvelope = { commandId: 'c1', command: { type: 'stopSession', sessionId: 's1' } };
  await sendCommand('pt_1', env);
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toContain('/v1/command');
  expect(JSON.parse(init.body)).toEqual(env);
  expect(init.headers.Authorization).toBe('Bearer pt_1');
});

test('a non-2xx response throws ApiError with the status', async () => {
  global.fetch = jest.fn(() => okJson({ error: 'invalid or expired pairing code' }, 400)) as unknown as typeof fetch;
  await expect(claimPairing('bad')).rejects.toMatchObject({ status: 400 });
});
