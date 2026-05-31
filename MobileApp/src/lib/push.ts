import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { registerPushToken } from '@/src/lib/api';

// Surface notifications while the app is foregrounded (the live stream also shows them).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

// The EAS project id (from app config `extra.eas.projectId`, populated by `eas init`).
// getExpoPushTokenAsync needs it on a real build — without it the token request fails on
// device — so we resolve it explicitly rather than relying on an implicit default.
function easProjectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId
  );
}

// Requests OS permission, gets the Expo push token, registers it with CloudService.
// Returns false if permission was denied (app still works while foregrounded).
export async function registerForPush(phoneToken: string): Promise<boolean> {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return false;
  const projectId = easProjectId();
  const { data: expoToken } = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  await registerPushToken(phoneToken, expoToken);
  return true;
}
