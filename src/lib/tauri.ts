import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Project, SessionMeta, SessionHistory, HistoryBlock, Action, ActionInput, ActionPatch, DetectedScript, GitStatus, GitUser } from '../types';

// Matches generated src/types/PtyKind.ts (kind is lowercased by serde rename_all=camelCase
// on the enum; struct-variant fields remain snake_case because ts-rs preserves field names
// in tagged enums).
export type PtyKindClient =
  | { kind: 'claude'; session_id?: string; model?: string; skip_permissions?: boolean }
  | { kind: 'action'; action_id: number };

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
  spawnPty: (projectId: number, kind: PtyKindClient, cols: number, rows: number) =>
    invoke<string>('spawn_pty', { projectId, kind, cols, rows }),
  ptyWrite: (ptyId: string, data: string) => invoke<void>('pty_write', { ptyId, data }),
  ptyResize: (ptyId: string, cols: number, rows: number) =>
    invoke<void>('pty_resize', { ptyId, cols, rows }),
  ptyKill: (ptyId: string) => invoke<void>('pty_kill', { ptyId }),
  onPtyOutput: (ptyId: string, cb: (bytes: Uint8Array) => void): Promise<UnlistenFn> =>
    listen<{ data: string }>(`pty:${ptyId}:output`, e => {
      const bin = atob(e.payload.data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      cb(arr);
    }),
  onPtyExit: (ptyId: string, cb: (code: number) => void): Promise<UnlistenFn> =>
    listen<{ code: number }>(`pty:${ptyId}:exit`, e => cb(e.payload.code)),
  listActions: (projectId: number) => invoke<Action[]>('list_actions', { projectId }),
  detectScripts: (projectPath: string) => invoke<DetectedScript[]>('detect_scripts', { projectPath }),
  addAction: (input: ActionInput) => invoke<Action>('add_action', { input }),
  updateAction: (id: number, patch: ActionPatch) => invoke<Action>('update_action', { id, patch }),
  removeAction: (id: number) => invoke<void>('remove_action', { id }),
  gitStatus: (projectId: number) => invoke<GitStatus>('git_status', { projectId }),
  getGitUser: () => invoke<GitUser>('get_git_user'),
  countSessions: (projectId: number) => invoke<number>('count_sessions', { projectId }),
  getSetting: (key: string) =>
    invoke<string | null>('get_setting', { key }),
  getAllSettings: () =>
    invoke<Record<string, string>>('get_all_settings'),
  setSetting: (key: string, value: string) =>
    invoke<void>('set_setting', { key, value }),
  deleteSetting: (key: string) =>
    invoke<void>('delete_setting', { key }),
};
