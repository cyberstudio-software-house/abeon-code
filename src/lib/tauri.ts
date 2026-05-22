import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Project, SessionMeta, SessionHistory, HistoryBlock } from '../types';

export const tauri = {
  listProjects: () => invoke<Project[]>('list_projects'),
  addProject: (name: string, path: string) =>
    invoke<Project>('add_project', { name, path }),
  updateProject: (id: number, patch: { name?: string; color?: string }) =>
    invoke<Project>('update_project', { id, ...patch }),
  removeProject: (id: number) => invoke<void>('remove_project', { id }),
  reorderProjects: (ids: number[]) => invoke<void>('reorder_projects', { ids }),
  listSessions: (projectId: number, limit = 20, offset = 0) =>
    invoke<SessionMeta[]>('list_sessions', { projectId, limit, offset }),
  readSessionHistory: (projectId: number, sessionId: string, limit?: number, beforeUuid?: string) =>
    invoke<SessionHistory>('read_session_history', { projectId, sessionId, limit, beforeUuid }),
  openSessionWatch: (projectId: number, sessionId: string) =>
    invoke<void>('open_session_watch', { projectId, sessionId }),
  closeSessionWatch: (sessionId: string) =>
    invoke<void>('close_session_watch', { sessionId }),
  onSessionAppend: (sessionId: string, cb: (blocks: HistoryBlock[]) => void): Promise<UnlistenFn> =>
    listen<{ blocks: HistoryBlock[] }>(`session:${sessionId}:append`, e => cb(e.payload.blocks)),
};
