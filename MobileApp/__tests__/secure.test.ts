jest.mock('expo-secure-store', () => {
  const mem: Record<string, string> = {};
  return {
    setItemAsync: jest.fn(async (k: string, v: string) => { mem[k] = v; }),
    getItemAsync: jest.fn(async (k: string) => mem[k] ?? null),
    deleteItemAsync: jest.fn(async (k: string) => { delete mem[k]; }),
  };
});
import { saveCredentials, loadCredentials, clearCredentials } from '@/src/lib/secure';

test('save then load round-trips the credentials', async () => {
  await saveCredentials({ phoneToken: 'pt_1', deviceId: 'dev_1' });
  expect(await loadCredentials()).toEqual({ phoneToken: 'pt_1', deviceId: 'dev_1' });
});

test('load returns null when nothing stored', async () => {
  await clearCredentials();
  expect(await loadCredentials()).toBeNull();
});
