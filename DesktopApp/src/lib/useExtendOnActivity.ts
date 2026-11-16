import { useEffect } from 'react';
import { tauri } from './tauri';

export const CARD_EXTEND_THROTTLE_MS = 10_000;

const ACTIVITY_EVENTS = ['mousemove', 'wheel', 'keydown', 'mousedown'] as const;

export function useExtendOnActivity(questionId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let lastSentAt = 0;

    const onActivity = () => {
      if (Date.now() - lastSentAt < CARD_EXTEND_THROTTLE_MS) return;
      lastSentAt = Date.now();
      tauri.supervisorExtendCard(questionId).catch(() => {});
    };

    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, onActivity, { capture: true, passive: true });
    }
    return () => {
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, true);
      }
    };
  }, [questionId, enabled]);
}
