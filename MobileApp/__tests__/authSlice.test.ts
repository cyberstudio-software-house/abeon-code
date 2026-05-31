jest.mock('@/src/lib/secure', () => ({
  saveCredentials: jest.fn(async () => {}),
  loadCredentials: jest.fn(async () => ({ phoneToken: 'pt_h', deviceId: 'dev_h' })),
  clearCredentials: jest.fn(async () => {}),
}));
import { createStore } from '@/src/store';

test('starts unpaired', () => {
  const s = createStore();
  expect(s.getState().status).toBe('unpaired');
});

test('pair() stores credentials and flips to paired', async () => {
  const s = createStore();
  await s.getState().pair({ phoneToken: 'pt_1', deviceId: 'dev_1' });
  expect(s.getState().status).toBe('paired');
  expect(s.getState().phoneToken).toBe('pt_1');
});

test('hydrate() loads stored credentials into state', async () => {
  const s = createStore();
  await s.getState().hydrate();
  expect(s.getState().status).toBe('paired');
  expect(s.getState().deviceId).toBe('dev_h');
});

test('unpair() clears state', async () => {
  const s = createStore();
  await s.getState().pair({ phoneToken: 'pt_1', deviceId: 'dev_1' });
  await s.getState().unpair();
  expect(s.getState().status).toBe('unpaired');
  expect(s.getState().phoneToken).toBeNull();
});
