jest.mock('@/src/lib/secure', () => ({ saveCredentials: jest.fn(async () => {}), loadCredentials: jest.fn(async () => null), clearCredentials: jest.fn(async () => {}) }));
jest.mock('@/src/lib/api', () => ({ fetchToken: jest.fn(async () => ({ token: 'jwt_1', expiresInSecs: 3600 })) }));
const mockHandles = { client: { on: jest.fn() }, subscribeSession: jest.fn(), subscribeDevice: jest.fn(), disconnect: jest.fn() };
jest.mock('@/src/lib/centrifugo', () => ({ createCentrifugo: jest.fn(() => mockHandles) }));

import { createStore } from '@/src/store';
import { fetchToken } from '@/src/lib/api';
import { createCentrifugo } from '@/src/lib/centrifugo';

beforeEach(() => jest.clearAllMocks());

test('connect() requires a paired token and opens centrifuge', async () => {
  const s = createStore();
  await s.getState().pair({ phoneToken: 'pt_1', deviceId: 'dev_1' });
  s.getState().connect();
  expect(createCentrifugo).toHaveBeenCalledTimes(1);
  const getToken = (createCentrifugo as jest.Mock).mock.calls[0][0];
  expect(await getToken()).toBe('jwt_1');
  expect(fetchToken).toHaveBeenCalledWith('pt_1');
  expect(mockHandles.subscribeDevice).toHaveBeenCalledWith('dev_1', expect.any(Function));
});

test('connect() is a no-op when unpaired', () => {
  const s = createStore();
  s.getState().connect();
  expect(createCentrifugo).not.toHaveBeenCalled();
});

test('disconnect() tears down the client', async () => {
  const s = createStore();
  await s.getState().pair({ phoneToken: 'pt_1', deviceId: 'dev_1' });
  s.getState().connect();
  s.getState().disconnect();
  expect(mockHandles.disconnect).toHaveBeenCalled();
});
