import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import { isBlankNote, notesListKey, type NotesListKey } from '../lib/noteText';
import type { Note } from '../types';

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
  backToNotesList: () => Promise<boolean>;
  editNoteDraft: (key: string, content: string) => void;
  flushNoteDraft: (key: string) => Promise<boolean>;
  retryNoteDraft: (key: string) => void;
  discardNoteDraft: (key: string) => void;
  releaseNoteDraft: (key: string, from: DraftHolder) => Promise<boolean>;
  deleteNoteById: (noteId: number) => Promise<boolean>;
  flushAllNoteDrafts: () => Promise<boolean>;
};

export function draftKeyForNote(state: Pick<NotesSlice, 'noteDrafts'>, noteId: number): string | null {
  const draft = Object.values(state.noteDrafts).find((d) => d.noteId === noteId);
  return draft ? draft.key : null;
}

export function hasUnsavedNotes(state: Pick<NotesSlice, 'noteDrafts'>): boolean {
  return Object.values(state.noteDrafts).some((d) =>
    d.status === 'saving' || (d.content !== d.savedContent && !(d.noteId === null && isBlankNote(d.content))));
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

const byRecency = (a: Note, b: Note) => b.updatedAt - a.updatedAt || b.id - a.id;

function isDirty(draft: NoteDraft): boolean {
  return draft.noteId === null ? !isBlankNote(draft.content) : draft.content !== draft.savedContent;
}

function withoutNote(lists: NotesSlice['notesLists'], noteId: number): NotesSlice['notesLists'] {
  const next: NotesSlice['notesLists'] = {};
  for (const [key, list] of Object.entries(lists) as [NotesListKey, NotesList][]) {
    next[key] = { ...list, notes: list.notes.filter((n) => n.id !== noteId) };
  }
  return next;
}

export const createNotesSlice: StateCreator<NotesSlice> = (set, get) => {
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
      const saved = draft.noteId === null
        ? await tauri.createNote(draft.projectId, snapshot)
        : await tauri.updateNote(draft.noteId, snapshot);
      const current = get().noteDrafts[key];
      if (!current) return;
      patchDraft(key, {
        noteId: saved.id,
        savedContent: snapshot,
        status: current.content === snapshot ? 'saved' : 'idle',
      });
      upsertNote(saved, current.projectId);
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
        const notes = await tauri.listNotes(projectId);
        if (loadTokens.get(listKey) !== token) return;
        set((s) => ({ notesLists: { ...s.notesLists, [listKey]: { status: 'ready', notes } } }));
      } catch {
        if (loadTokens.get(listKey) !== token) return;
        set((s) => ({ notesLists: { ...s.notesLists, [listKey]: { status: 'error', notes: s.notesLists[listKey]?.notes ?? [] } } }));
      }
    },

    reloadNotes: async () => {
      const loadedKeys = Object.keys(get().notesLists) as NotesListKey[];
      const fetched = new Map<number, Note>();
      await Promise.all(loadedKeys.map(async (listKey) => {
        const projectId = listKey === 'global' ? null : Number(listKey.slice('project:'.length));
        const token = nextLoadToken(listKey);
        try {
          const notes = await tauri.listNotes(projectId);
          notes.forEach((n) => fetched.set(n.id, n));
          if (loadTokens.get(listKey) !== token) return;
          set((s) => ({ notesLists: { ...s.notesLists, [listKey]: { status: 'ready', notes } } }));
        } catch {
          return;
        }
      }));
      const isClean = (d: NoteDraft | undefined): d is NoteDraft =>
        d !== undefined && d.noteId !== null && d.content === d.savedContent && d.status !== 'saving';
      const candidates = Object.values(get().noteDrafts).filter(isClean);
      await Promise.all(candidates.map(async (candidate) => {
        const noteId = candidate.noteId as number;
        let note = fetched.get(noteId);
        if (!note && !loadedKeys.includes(notesListKey(candidate.projectId))) {
          try {
            note = await tauri.getNote(noteId);
          } catch {
            return;
          }
        }
        if (!note) return;
        const current = get().noteDrafts[candidate.key];
        if (!isClean(current) || current.content === note.content) return;
        patchDraft(candidate.key, { content: note.content, savedContent: note.content });
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
      const otherHolder = from !== 'panel' && view.mode === 'editor' && view.draftKey === key;
      if (otherHolder) return get().flushNoteDraft(key);
      if (isBlankNote(draft.content)) {
        clearSaveTimer(key);
        await saveChains.get(key);
        const settled = get().noteDrafts[key];
        if (!settled) return true;
        if (settled.noteId !== null) {
          try {
            await tauri.deleteNote(settled.noteId);
          } catch {
            return false;
          }
          const removedId = settled.noteId;
          set((s) => ({ notesLists: withoutNote(s.notesLists, removedId) }));
        }
        dropDraft(key);
        return true;
      }
      if (!(await get().flushNoteDraft(key))) return false;
      dropDraft(key);
      return true;
    },

    deleteNoteById: async (noteId) => {
      try {
        await tauri.deleteNote(noteId);
      } catch {
        return false;
      }
      const keys = Object.values(get().noteDrafts).filter((d) => d.noteId === noteId).map((d) => d.key);
      keys.forEach((key) => dropDraft(key));
      set((s) => ({ notesLists: withoutNote(s.notesLists, noteId) }));
      return true;
    },

    flushAllNoteDrafts: async () => {
      const results = await Promise.all(Object.keys(get().noteDrafts).map((key) => get().flushNoteDraft(key)));
      return results.every(Boolean);
    },
  };
};
