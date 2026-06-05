import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Project, SessionMeta, SessionActivity, SessionHistory, HistoryBlock, Action, ActionInput, ActionPatch, DetectedScript, GitStatus, GitUser, ShellInfo, EditorInfo, DiffResult, UsageSummary, DetectedModel } from '../types';

// Matches generated src/types/PtyKind.ts (kind is lowercased by serde rename_all=camelCase
// on the enum; struct-variant fields remain snake_case because ts-rs preserves field names
// in tagged enums).
export type PairCode = { code: string; expiresInSecs: number };

export type AttentionReason = 'hook' | 'heuristic';
export type AttentionEvent = { sessionId: string; reason: AttentionReason; message: string | null };

export type PtyKindClient =
  | { kind: 'claude'; session_id?: string; model?: string; skip_permissions?: boolean; fresh?: boolean }
  | { kind: 'action'; action_id: number }
  | { kind: 'shell' };

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
  onSessionActivity: (sessionId: string, cb: (activity: SessionActivity) => void): Promise<UnlistenFn> =>
    listen<{ activity: SessionActivity }>(`session:${sessionId}:activity`, e => cb(e.payload.activity)),
  onSessionTitle: (sessionId: string, cb: (title: string) => void): Promise<UnlistenFn> =>
    listen<{ title: string }>(`session:${sessionId}:title`, e => cb(e.payload.title)),
  sessionUsage: (projectId: number, sessionId: string) =>
    invoke<UsageSummary>('session_usage', { projectId, sessionId }),
  projectUsage: (projectId: number) =>
    invoke<UsageSummary>('project_usage', { projectId }),
  detectModels: (force?: boolean) =>
    invoke<DetectedModel[]>('detect_models', { force }),
  onSessionUsage: (sessionId: string, cb: (usage: UsageSummary) => void): Promise<UnlistenFn> =>
    listen<UsageSummary>(`session:${sessionId}:usage`, e => cb(e.payload)),
  spawnPty: (projectId: number, kind: PtyKindClient, cols: number, rows: number) =>
    invoke<string>('spawn_pty', { projectId, kind, cols, rows }),
  ptyWrite: (ptyId: string, data: string) => invoke<void>('pty_write', { ptyId, data }),
  ptyResize: (ptyId: string, cols: number, rows: number) =>
    invoke<void>('pty_resize', { ptyId, cols, rows }),
  ptyKill: (ptyId: string) => invoke<void>('pty_kill', { ptyId }),
  saveClipboardImage: (ptyId: string, data: string) =>
    invoke<string>('save_clipboard_image', { ptyId, data }),
  readClipboardImage: (ptyId: string) =>
    invoke<string | null>('read_clipboard_image', { ptyId }),
  readClipboardText: () =>
    invoke<string | null>('read_clipboard_text'),
  writeClipboardText: (text: string) =>
    invoke<void>('write_clipboard_text', { text }),
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
  gitDiffFile: (projectId: number, repoLabel: string, filePath: string) =>
    invoke<DiffResult>('git_diff_file', { projectId, repoLabel, filePath }),
  getGitUser: () => invoke<GitUser>('get_git_user'),
  renameSession: (projectId: number, sessionId: string, title: string) =>
    invoke<void>('rename_session', { projectId, sessionId, title }),
  generateSessionTitle: (projectId: number, sessionId: string, model?: string) =>
    invoke<string>('generate_session_title', { projectId, sessionId, model }),
  countSessions: (projectId: number) => invoke<number>('count_sessions', { projectId }),
  getSetting: (key: string) =>
    invoke<string | null>('get_setting', { key }),
  getAllSettings: () =>
    invoke<Record<string, string>>('get_all_settings'),
  setSetting: (key: string, value: string) =>
    invoke<void>('set_setting', { key, value }),
  deleteSetting: (key: string) =>
    invoke<void>('delete_setting', { key }),
  detectDefaultShell: () => invoke<string | null>('detect_default_shell'),
  listAvailableShells: () => invoke<ShellInfo[]>('list_available_shells'),
  getProjectsActivity: () =>
    invoke<Record<number, number>>('get_projects_activity'),
  openInEditor: (projectPath: string, filePath: string, line?: number, col?: number) =>
    invoke<void>('open_in_editor', { projectPath, filePath, line, col }),
  listAvailableEditors: () => invoke<EditorInfo[]>('list_available_editors'),
  openProjectInEditor: (projectPath: string) =>
    invoke<void>('open_project_in_editor', { projectPath }),
  setWindowTitle: (title: string) => getCurrentWindow().setTitle(title),
  remotePairStart: () => invoke<PairCode>('remote_pair_start'),
  onSessionAttention: (cb: (e: AttentionEvent) => void): Promise<UnlistenFn> =>
    listen<AttentionEvent>('session-attention', e => cb(e.payload)),
  installAttentionHook: () => invoke<void>('install_attention_hook'),
  uninstallAttentionHook: () => invoke<void>('uninstall_attention_hook'),
  attentionHookStatus: () => invoke<boolean>('attention_hook_status'),
};
