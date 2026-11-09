import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import { isBlankNote, noteTitle, notesListKey, type NotesListKey } from '../lib/noteText';
import type { Note } from '../types';
import type { AppState } from './index';

export const NOTE_SAVE_DEBOUNCE_MS = 700;

export type NotesScope = 'project' | 'global';
export type NotesList = { status: 'loading' | 'ready' | 'error'; notes: Note[] };
export type NoteSaveStatus = 'idle' | 'saving' | 'saved' | 'error';
export type NoteDraft = {
  key: string;
  noteId: number | null;
  projectId: number | null;
  content: string;
  savedContent: string;
  status: NoteSaveStatus;
  replacesNoteId?: number;
};
export type NotesView = { mode: 'list' } | { mode: 'editor'; draftKey: string };
export type DraftHolder = 'panel' | { tabId: string };

export type NotesSlice = {
  notesPanelOpen: boolean;
  notesScope: NotesScope;
  notesView: NotesView;
  notesLists: Partial<Record<NotesListKey, NotesList>>;
  noteDrafts: Record<string, NoteDraft>;
  openNotesPanel: () => void;
  closeNotesPanel: () => Promise<boolean>;
  setNotesScope: (scope: NotesScope) => void;
  loadNotes: (projectId: number | null) => Promise<void>;
  reloadNotes: () => Promise<void>;
  startNewNote: (projectId: number | null) => void;
  openNoteInPanel: (note: Note) => void;
  ensureNoteDraft: (noteId: number) => Promise<string | null>;
  openNoteInTab: (key: string) => Promise<boolean>;
  backToNotesList: () => Promise<boolean>;
  editNoteDraft: (key: string, content: string) => void;
  flushNoteDraft: (key: string) => Promise<boolean>;
  retryNoteDraft: (key: string) => void;
  discardNoteDraft: (key: string) => void;
  releaseNoteDraft: (key: string, from: DraftHolder) => Promise<boolean>;
  deleteNoteById: (noteId: number) => Promise<boolean>;
  flushAllNoteDrafts: () => Promise<boolean>;
  settleNoteDraftsForExit: () => Promise<boolean>;
};

export function draftKeyForNote(state: Pick<NotesSlice, 'noteDrafts'>, noteId: number): string | null {
  const draft = Object.values(state.noteDrafts).find((d) => d.noteId === noteId || d.replacesNoteId === noteId);
  return draft ? draft.key : null;
}

export function hasUnsavedNotes(state: Pick<NotesSlice, 'noteDrafts'>): boolean {
  return Object.values(state.noteDrafts).some((d) =>
    d.status === 'saving' || (d.content !== d.savedContent && !(d.noteId === null && isBlankNote(d.content))));
}

export function hasNotesToSettle(state: Pick<NotesSlice, 'noteDrafts'>): boolean {
  return hasUnsavedNotes(state) || Object.values(state.noteDrafts).some((d) => d.noteId !== null && isBlankNote(d.content));
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saveChains = new Map<string, Promise<void>>();
const loadTokens = new Map<NotesListKey, number>();

function clearSaveTimer(key: string) {
  const timer = saveTimers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  saveTimers.delete(key);
}

function nextLoadToken(listKey: NotesListKey): number {
  const token = (loadTokens.get(listKey) ?? 0) + 1;
  loadTokens.set(listKey, token);
  return token;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'not_found';
}

const byRecency = (a: Note, b: Note) => b.updatedAt - a.updatedAt || b.id - a.id;

function isDirty(draft: NoteDraft): boolean {
  return draft.noteId === null ? !isBlankNote(draft.content) : draft.content !== draft.savedContent;
}

function mergeFetched(existing: Note[], fetched: Note[]): Note[] {
  const known = new Map(existing.map((n) => [n.id, n]));
  return fetched.map((n) => {
    const local = known.get(n.id);
    return local && local.updatedAt > n.updatedAt ? local : n;
  });
}

function withoutNote(lists: NotesSlice['notesLists'], noteId: number): NotesSlice['notesLists'] {
  const next: NotesSlice['notesLists'] = {};
  for (const [key, list] of Object.entries(lists) as [NotesListKey, NotesList][]) {
    next[key] = { ...list, notes: list.notes.filter((n) => n.id !== noteId) };
  }
  return next;
}

export const createNotesSlice: StateCreator<AppState, [], [], NotesSlice> = (set, get) => {
  const patchDraft = (key: string, patch: Partial<NoteDraft>) => {
    set((s) => (s.noteDrafts[key] ? { noteDrafts: { ...s.noteDrafts, [key]: { ...s.noteDrafts[key], ...patch } } } : s));
  };

  const dropDraft = (key: string) => {
    clearSaveTimer(key);
    saveChains.delete(key);
    set((s) => {
      const { [key]: _removed, ...rest } = s.noteDrafts;
      const view = s.notesView.mode === 'editor' && s.notesView.draftKey === key ? { mode: 'list' as const } : s.notesView;
      return { noteDrafts: rest, notesView: view };
    });
  };

  const retitleNoteTabs = (noteId: number, content: string) => {
    const title = noteTitle(content);
    set((s) => {
      const stale = s.tabs.some((t) => t.kind === 'note' && t.noteId === noteId && t.title !== title);
      if (!stale) return s;
      return { tabs: s.tabs.map((t) => (t.kind === 'note' && t.noteId === noteId ? { ...t, title } : t)) };
    });
  };

  const repointNoteTabs = (fromId: number, toId: number, content: string) => {
    const title = noteTitle(content);
    set((s) => {
      if (!s.tabs.some((t) => t.kind === 'note' && t.noteId === fromId)) return s;
      return { tabs: s.tabs.map((t) => (t.kind === 'note' && t.noteId === fromId ? { ...t, noteId: toId, title } : t)) };
    });
  };

  const deleteNoteRecord = async (noteId: number): Promise<boolean> => {
    try {
      await tauri.deleteNote(noteId);
    } catch (error) {
      if (!isNotFoundError(error)) return false;
    }
    set((s) => ({ notesLists: withoutNote(s.notesLists, noteId) }));
    return true;
  };

  const upsertNote = (note: Note, projectId: number | null) => {
    const listKey = notesListKey(projectId);
    set((s) => {
      const list = s.notesLists[listKey];
      if (!list) return s;
      const notes = [...list.notes.filter((n) => n.id !== note.id), note].sort(byRecency);
      return { notesLists: { ...s.notesLists, [listKey]: { ...list, notes } } };
    });
  };

  const runSave = async (key: string) => {
    const draft = get().noteDrafts[key];
    if (!draft) return;
    const snapshot = draft.content;
    if (draft.noteId === null && isBlankNote(snapshot)) return;
    if (draft.noteId !== null && snapshot === draft.savedContent) return;
    patchDraft(key, { status: 'saving' });
    try {
      let created = draft.noteId === null;
      let recreatedFrom: number | null = null;
      let saved: Note;
      if (draft.noteId === null) {
        saved = await tauri.createNote(draft.projectId, snapshot);
        recreatedFrom = draft.replacesNoteId ?? null;
      } else {
        const removedId = draft.noteId;
        try {
          saved = await tauri.updateNote(removedId, snapshot);
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
          set((s) => ({ notesLists: withoutNote(s.notesLists, removedId) }));
          if (isBlankNote(snapshot)) {
            patchDraft(key, { noteId: null, savedContent: '', replacesNoteId: removedId, status: 'idle' });
            return;
          }
          patchDraft(key, { noteId: null, savedContent: '', replacesNoteId: removedId });
          created = true;
          saved = await tauri.createNote(draft.projectId, snapshot);
          recreatedFrom = removedId;
        }
      }
      if (recreatedFrom !== null) repointNoteTabs(recreatedFrom, saved.id, snapshot);
      const current = get().noteDrafts[key];
      if (!current) return;
      patchDraft(key, {
        noteId: saved.id,
        replacesNoteId: undefined,
        savedContent: snapshot,
        status: current.content === snapshot ? 'saved' : 'idle',
      });
      upsertNote(saved, current.projectId);
      if (created) retitleNoteTabs(saved.id, current.content);
    } catch {
      patchDraft(key, { status: 'error' });
    }
  };

  const enqueueSave = (key: string): Promise<void> => {
    const next = (saveChains.get(key) ?? Promise.resolve()).then(() => runSave(key));
    saveChains.set(key, next);
    return next;
  };

  const scheduleSave = (key: string) => {
    clearSaveTimer(key);
    saveTimers.set(key, setTimeout(() => {
      saveTimers.delete(key);
      void enqueueSave(key);
    }, NOTE_SAVE_DEBOUNCE_MS));
  };

  const newDraft = (key: string, fields: Pick<NoteDraft, 'noteId' | 'projectId' | 'content'>): NoteDraft => ({
    key, ...fields, savedContent: fields.noteId === null ? '' : fields.content, status: 'idle',
  });

  const panelDraftKey = (): string | null => {
    const view = get().notesView;
    return view.mode === 'editor' ? view.draftKey : null;
  };

  const releasePanelDraft = async (): Promise<boolean> => {
    const key = panelDraftKey();
    return key === null ? true : get().releaseNoteDraft(key, 'panel');
  };

  return {
    notesPanelOpen: false,
    notesScope: 'project',
    notesView: { mode: 'list' },
    notesLists: {},
    noteDrafts: {},

    openNotesPanel: () => set({ notesPanelOpen: true }),

    closeNotesPanel: async () => {
      if (panelDraftKey() === null) {
        set({ notesPanelOpen: false });
        return true;
      }
      if (!(await releasePanelDraft())) return false;
      set({ notesPanelOpen: false, notesView: { mode: 'list' } });
      return true;
    },

    setNotesScope: (scope) => set({ notesScope: scope }),

    loadNotes: async (projectId) => {
      const listKey = notesListKey(projectId);
      const token = nextLoadToken(listKey);
      const previous = get().notesLists[listKey]?.notes ?? [];
      set((s) => ({ notesLists: { ...s.notesLists, [listKey]: { status: 'loading', notes: previous } } }));
      try {
        const fetched = await tauri.listNotes(projectId);
        if (loadTokens.get(listKey) !== token) return;
        set((s) => {
          const notes = mergeFetched(s.notesLists[listKey]?.notes ?? [], fetched);
          return { notesLists: { ...s.notesLists, [listKey]: { status: 'ready', notes } } };
        });
      } catch {
        if (loadTokens.get(listKey) !== token) return;
        set((s) => ({ notesLists: { ...s.notesLists, [listKey]: { status: 'error', notes: s.notesLists[listKey]?.notes ?? [] } } }));
      }
    },

    reloadNotes: async () => {
      const loadedKeys = Object.keys(get().notesLists) as NotesListKey[];
      const isClean = (d: NoteDraft | undefined): d is NoteDraft =>
        d !== undefined && d.noteId !== null && d.content === d.savedContent && d.status !== 'saving';
      const baseline = new Map<string, string>();
      Object.values(get().noteDrafts).filter(isClean).forEach((d) => baseline.set(d.key, d.savedContent));
      const fetched = new Map<number, Note>();
      await Promise.all(loadedKeys.map(async (listKey) => {
        const projectId = listKey === 'global' ? null : Number(listKey.slice('project:'.length));
        const token = nextLoadToken(listKey);
        try {
          const notes = await tauri.listNotes(projectId);
          notes.forEach((n) => fetched.set(n.id, n));
          if (loadTokens.get(listKey) !== token) return;
          set((s) => {
            const merged = mergeFetched(s.notesLists[listKey]?.notes ?? [], notes);
            return { notesLists: { ...s.notesLists, [listKey]: { status: 'ready', notes: merged } } };
          });
        } catch {
          if (loadTokens.get(listKey) !== token) return;
          set((s) => ({ notesLists: { ...s.notesLists, [listKey]: { status: 'error', notes: s.notesLists[listKey]?.notes ?? [] } } }));
        }
      }));
      await Promise.all([...baseline.keys()].map(async (draftKey) => {
        const candidate = get().noteDrafts[draftKey];
        if (!candidate || candidate.noteId === null) return;
        const noteId = candidate.noteId;
        let note = fetched.get(noteId);
        if (!note && !loadedKeys.includes(notesListKey(candidate.projectId))) {
          try {
            note = await tauri.getNote(noteId);
          } catch {
            return;
          }
        }
        if (!note) return;
        const current = get().noteDrafts[draftKey];
        if (!isClean(current) || current.savedContent !== baseline.get(draftKey) || current.content === note.content) return;
        patchDraft(draftKey, { content: note.content, savedContent: note.content });
        retitleNoteTabs(noteId, note.content);
      }));
    },

    startNewNote: (projectId) => {
      const key = crypto.randomUUID();
      set((s) => ({
        noteDrafts: { ...s.noteDrafts, [key]: newDraft(key, { noteId: null, projectId, content: '' }) },
        notesView: { mode: 'editor', draftKey: key },
      }));
    },

    openNoteInPanel: (note) => {
      const existing = draftKeyForNote(get(), note.id);
      if (existing) {
        set({ notesView: { mode: 'editor', draftKey: existing } });
        return;
      }
      const key = crypto.randomUUID();
      set((s) => ({
        noteDrafts: {
          ...s.noteDrafts,
          [key]: newDraft(key, { noteId: note.id, projectId: note.projectId, content: note.content }),
        },
        notesView: { mode: 'editor', draftKey: key },
      }));
    },

    ensureNoteDraft: async (noteId) => {
      const existing = draftKeyForNote(get(), noteId);
      if (existing) return existing;
      let note: Note;
      try {
        note = await tauri.getNote(noteId);
      } catch {
        return null;
      }
      const raced = draftKeyForNote(get(), noteId);
      if (raced) return raced;
      const key = crypto.randomUUID();
      set((s) => ({
        noteDrafts: {
          ...s.noteDrafts,
          [key]: newDraft(key, { noteId: note.id, projectId: note.projectId, content: note.content }),
        },
      }));
      return key;
    },

    openNoteInTab: async (key) => {
      if (!(await get().flushNoteDraft(key))) return false;
      const draft = get().noteDrafts[key];
      if (!draft || draft.noteId === null) return false;
      const state = get();
      const projectId = draft.projectId ?? state.tabs.find((t) => t.id === state.activeTabId)?.projectId;
      if (projectId === undefined) return false;
      state.openNoteTab(draft.noteId, projectId, noteTitle(draft.content));
      if (panelDraftKey() === key) set({ notesView: { mode: 'list' } });
      return true;
    },

    backToNotesList: async () => {
      const key = panelDraftKey();
      if (key === null) {
        set({ notesView: { mode: 'list' } });
        return true;
      }
      if (!(await get().releaseNoteDraft(key, 'panel'))) return false;
      const view = get().notesView;
      if (view.mode === 'editor' && view.draftKey === key) set({ notesView: { mode: 'list' } });
      return true;
    },

    editNoteDraft: (key, content) => {
      const draft = get().noteDrafts[key];
      if (!draft) return;
      patchDraft(key, { content, status: draft.status === 'saving' ? 'saving' : 'idle' });
      const tabNoteId = draft.noteId ?? draft.replacesNoteId;
      if (tabNoteId !== undefined && tabNoteId !== null) retitleNoteTabs(tabNoteId, content);
      if (draft.noteId === null && isBlankNote(content)) clearSaveTimer(key);
      else scheduleSave(key);
    },

    flushNoteDraft: async (key) => {
      clearSaveTimer(key);
      const draft = get().noteDrafts[key];
      if (!draft) return true;
      if (isDirty(draft)) void enqueueSave(key);
      await saveChains.get(key);
      return get().noteDrafts[key]?.status !== 'error';
    },

    retryNoteDraft: (key) => {
      clearSaveTimer(key);
      void enqueueSave(key);
    },

    discardNoteDraft: (key) => {
      const draft = get().noteDrafts[key];
      if (!draft || draft.noteId !== null) return;
      dropDraft(key);
    },

    releaseNoteDraft: async (key, from) => {
      const draft = get().noteDrafts[key];
      if (!draft) return true;
      const view = get().notesView;
      const panelHolds = from !== 'panel' && view.mode === 'editor' && view.draftKey === key;
      const releasingTabId = from === 'panel' ? null : from.tabId;
      const heldIds = [draft.noteId, draft.replacesNoteId].filter((id): id is number => id !== null && id !== undefined);
      const tabHolds = get().tabs.some((t) => t.kind === 'note' && heldIds.includes(t.noteId) && t.id !== releasingTabId);
      const otherHolder = panelHolds || tabHolds;
      if (otherHolder) return get().flushNoteDraft(key);
      for (;;) {
        const current = get().noteDrafts[key];
        if (!current) return true;
        if (isBlankNote(current.content)) {
          clearSaveTimer(key);
          await saveChains.get(key);
          const settled = get().noteDrafts[key];
          if (!settled) return true;
          if (!isBlankNote(settled.content)) continue;
          if (settled.noteId !== null) {
            if (!(await deleteNoteRecord(settled.noteId))) return false;
            const afterDelete = get().noteDrafts[key];
            if (afterDelete && !isBlankNote(afterDelete.content)) {
              patchDraft(key, { noteId: null, savedContent: '', status: 'idle' });
              continue;
            }
          }
          dropDraft(key);
          return true;
        }
        if (!(await get().flushNoteDraft(key))) return false;
        const flushed = get().noteDrafts[key];
        if (!flushed) return true;
        if (!isDirty(flushed)) {
          dropDraft(key);
          return true;
        }
      }
    },

    deleteNoteById: async (noteId) => {
      if (!(await deleteNoteRecord(noteId))) return false;
      const keys = Object.values(get().noteDrafts).filter((d) => d.noteId === noteId).map((d) => d.key);
      keys.forEach((key) => dropDraft(key));
      get().tabs.filter((t) => t.kind === 'note' && t.noteId === noteId).forEach((t) => get().closeTab(t.id));
      return true;
    },

    flushAllNoteDrafts: async () => {
      const results = await Promise.all(Object.keys(get().noteDrafts).map((key) => get().flushNoteDraft(key)));
      return results.every(Boolean);
    },

    settleNoteDraftsForExit: async () => {
      const settleDraft = async (key: string): Promise<boolean> => {
        const draft = get().noteDrafts[key];
        if (!draft) return true;
        if (draft.noteId === null || !isBlankNote(draft.content)) return get().flushNoteDraft(key);
        clearSaveTimer(key);
        await saveChains.get(key);
        const settled = get().noteDrafts[key];
        if (!settled || settled.noteId === null) return true;
        if (!isBlankNote(settled.content)) return get().flushNoteDraft(key);
        const removedId = settled.noteId;
        if (!(await deleteNoteRecord(removedId))) return false;
        if (!get().noteDrafts[key]) return true;
        patchDraft(key, { noteId: null, savedContent: '', replacesNoteId: removedId, status: 'idle' });
        return isBlankNote(get().noteDrafts[key].content) ? true : get().flushNoteDraft(key);
      };
      const results = await Promise.all(Object.keys(get().noteDrafts).map(settleDraft));
      return results.every(Boolean);
    },
  };
};
