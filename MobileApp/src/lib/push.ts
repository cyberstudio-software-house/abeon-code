import * as Notifications from 'expo-notifications';
import { registerPushToken } from '@/src/lib/api';

// Surface notifications while the app is foregrounded (the live stream also shows them).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

// Requests OS permission, gets the Expo push token, registers it with CloudService.
// Returns false if permission was denied (app still works while foregrounded).
export async function registerForPush(phoneToken: string): Promise<boolean> {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return false;
  const { data: expoToken } = await Notifications.getExpoPushTokenAsync();
  await registerPushToken(phoneToken, expoToken);
  return true;
}
