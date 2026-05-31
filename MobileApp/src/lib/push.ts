import Constants from 'expo-constants';
import { registerPushToken } from '@/src/lib/api';

// expo-notifications' remote-push API was removed from Expo Go (SDK 53+) — importing or
// using it there THROWS at module load. So we feature-detect the runtime and lazy-load
// the module only in a real (dev/preview/production) build. In Expo Go push is simply
// disabled and the rest of the app loads normally.
const PUSH_SUPPORTED = Constants.executionEnvironment !== 'storeClient';

type NotificationsModule = typeof import('expo-notifications');
function loadNotifications(): NotificationsModule {
  return require('expo-notifications') as NotificationsModule;
}

// The EAS project id (from app config `extra.eas.projectId`, populated by `eas init`).
// getExpoPushTokenAsync needs it on a real build, so we resolve it explicitly.
function easProjectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId
  );
}

// Surface notifications while the app is foregrounded. Safe to call anywhere — a no-op
// in Expo Go.
export function initPushHandler(): void {
  if (!PUSH_SUPPORTED) return;
  loadNotifications().setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

// Requests OS permission, gets the Expo push token, registers it with CloudService.
// Returns false if push is unsupported (Expo Go), permission was denied, or token
// acquisition failed. Push is a best-effort enhancement (Plan 3) — pairing and sessions
// must work without it — so every failure is swallowed here rather than propagated. On a
// real Android build getExpoPushTokenAsync throws unless FCM (`googleServicesFile`) is
// configured; callers use `void registerForPush(...)`, so an unhandled rejection here
// would surface as a runtime error and look like a crash. Keep it contained.
export async function registerForPush(phoneToken: string): Promise<boolean> {
  if (!PUSH_SUPPORTED) return false;
  try {
    const Notifications = loadNotifications();
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') return false;
    const projectId = easProjectId();
    const { data: expoToken } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    await registerPushToken(phoneToken, expoToken);
    return true;
  } catch (e) {
    // FCM not configured, network error, etc. — log and continue without push.
    console.warn('[push] registration skipped:', e);
    return false;
  }
}

// Registers a tap handler that deep-links to the session carried in the push `data`.
// Returns a no-op remover in Expo Go.
export function addPushResponseListener(onSession: (sessionId: string) => void): { remove: () => void } {
  if (!PUSH_SUPPORTED) return { remove: () => {} };
  const sub = loadNotifications().addNotificationResponseReceivedListener((resp) => {
    const data = resp.notification.request.content.data as { sessionId?: string } | undefined;
    if (data?.sessionId) onSession(data.sessionId);
  });
  return { remove: () => sub.remove() };
}
