import type { StateCreator } from 'zustand';
import type { SessionEvent } from '@/src/types/SessionEvent';
import type { HistoryBlock } from '@/src/types/HistoryBlock';
import type { SessionActivity } from '@/src/types/SessionActivity';
import type { UsageSummary } from '@/src/types/UsageSummary';

export interface Session {
  id: string;
  title: string | null;
  activity: SessionActivity | null;
  usage: UsageSummary | null;
  projectId: number | null;
  projectName: string | null;
  lastEventAt: number;
}

export interface SessionsSlice {
  sessions: Map<string, Session>;
  history: Map<string, HistoryBlock[]>;
  applySessionEvent: (e: SessionEvent) => void;
  resetSessions: () => void;
}

function upsert(map: Map<string, Session>, id: string): Session {
  return map.get(id) ?? { id, title: null, activity: null, usage: null, projectId: null, projectName: null, lastEventAt: 0 };
}

export const createSessionsSlice: StateCreator<SessionsSlice, [], [], SessionsSlice> = (set, get) => ({
  sessions: new Map(),
  history: new Map(),
  resetSessions: () => set({ sessions: new Map(), history: new Map() }),
  applySessionEvent: (e) => {
    if (e.type === 'sessionRoster') {
      const sessions = new Map(get().sessions);
      for (const entry of e.entries) {
        const prev = upsert(sessions, entry.sessionId);
        sessions.set(entry.sessionId, {
          ...prev,
          title: entry.title,
          activity: entry.activity,
          projectId: entry.projectId,
          projectName: entry.projectName,
          lastEventAt: entry.lastModified,
        });
      }
      set({ sessions });
      return;
    }
    const sessions = new Map(get().sessions);
    const history = new Map(get().history);
    const s: Session = { ...upsert(sessions, e.sessionId), lastEventAt: Date.now() };
    switch (e.type) {
      case 'sessionTitle': s.title = e.title; break;
      case 'sessionActivity': s.activity = e.activity; break;
      case 'sessionUsage': s.usage = e.summary; break;
      case 'sessionAppend': {
        const prev = history.get(e.sessionId) ?? [];
        const seen = new Set(prev.map((b) => b.uuid));
        history.set(e.sessionId, [...prev, ...e.blocks.filter((b) => !seen.has(b.uuid))]);
        break;
      }
    }
    sessions.set(e.sessionId, s);
    set({ sessions, history });
  },
});
