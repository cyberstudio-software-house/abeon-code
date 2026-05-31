import * as SecureStore from 'expo-secure-store';

export interface Credentials { phoneToken: string; deviceId: string; }
const PHONE_TOKEN = 'abeoncloud.phoneToken';
const DEVICE_ID = 'abeoncloud.deviceId';
const SERVER_URL = 'abeoncloud.cloudServiceUrl';

export async function saveServerUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(SERVER_URL, url);
}
export async function loadServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_URL);
}

export async function saveCredentials(c: Credentials): Promise<void> {
  await SecureStore.setItemAsync(PHONE_TOKEN, c.phoneToken);
  await SecureStore.setItemAsync(DEVICE_ID, c.deviceId);
}
export async function loadCredentials(): Promise<Credentials | null> {
  const phoneToken = await SecureStore.getItemAsync(PHONE_TOKEN);
  const deviceId = await SecureStore.getItemAsync(DEVICE_ID);
  return phoneToken && deviceId ? { phoneToken, deviceId } : null;
}
export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(PHONE_TOKEN);
  await SecureStore.deleteItemAsync(DEVICE_ID);
}
