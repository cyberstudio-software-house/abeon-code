import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Note } from '../types';

const tauriMock = vi.hoisted(() => ({
  listNotes: vi.fn(),
  getNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));

vi.mock('../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, ...tauriMock } };
});

import { useStore } from './index';
import { draftKeyForNote, hasUnsavedNotes } from './notesSlice';

const note = (id: number, content: string, updatedAt = id * 10, projectId: number | null = 2): Note => ({
  id, projectId, content, createdAt: 1, updatedAt,
});

const state = () => useStore.getState();
const draftOf = (noteId: number) => state().noteDrafts[draftKeyForNote(state(), noteId) as string];
const onlyDraftKey = () => Object.keys(state().noteDrafts)[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('notesSlice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllTimers();
    Object.values(tauriMock).forEach((mock) => mock.mockReset());
    useStore.setState({
      tabs: [], activeTabId: null,
      notesPanelOpen: false, notesScope: 'project', notesView: { mode: 'list' }, notesLists: {}, noteDrafts: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces edits and creates the note once', async () => {
    tauriMock.createNote.mockResolvedValue(note(9, 'AB', 100));
    state().startNewNote(2);
    const key = onlyDraftKey();
    state().editNoteDraft(key, 'A');
    state().editNoteDraft(key, 'AB');
    await vi.advanceTimersByTimeAsync(699);
    expect(tauriMock.createNote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tauriMock.createNote).toHaveBeenCalledTimes(1);
    expect(tauriMock.createNote).toHaveBeenCalledWith(2, 'AB');
    expect(state().noteDrafts[key].noteId).toBe(9);
    expect(state().noteDrafts[key].status).toBe('saved');
  });

  it('never stores a blank new note', async () => {
    state().startNewNote(2);
    const key = onlyDraftKey();
    state().editNoteDraft(key, '  ');
    expect(await state().flushNoteDraft(key)).toBe(true);
    expect(tauriMock.createNote).not.toHaveBeenCalled();
  });

  it('edits during an in-flight create update the created note', async () => {
    const created = deferred<Note>();
    tauriMock.createNote.mockReturnValue(created.promise);
    tauriMock.updateNote.mockResolvedValue(note(9, 'AB', 200));
    state().startNewNote(2);
    const key = onlyDraftKey();
    state().editNoteDraft(key, 'A');
    await vi.advanceTimersByTimeAsync(700);
    state().editNoteDraft(key, 'AB');
    created.resolve(note(9, 'A', 100));
    expect(await state().flushNoteDraft(key)).toBe(true);
    expect(tauriMock.createNote).toHaveBeenCalledTimes(1);
    expect(tauriMock.updateNote).toHaveBeenCalledWith(9, 'AB');
    expect(state().noteDrafts[key].status).toBe('saved');
  });

  it('backToNotesList flushes pending text immediately', async () => {
    tauriMock.updateNote.mockResolvedValue(note(5, 'XY', 50));
    state().openNoteInPanel(note(5, 'X'));
    state().editNoteDraft(onlyDraftKey(), 'XY');
    expect(await state().backToNotesList()).toBe(true);
    expect(tauriMock.updateNote).toHaveBeenCalledWith(5, 'XY');
    expect(state().notesView).toEqual({ mode: 'list' });
    expect(state().noteDrafts).toEqual({});
  });

  it('a failed save keeps the text and the editor', async () => {
    tauriMock.updateNote.mockRejectedValue(new Error('boom'));
    state().openNoteInPanel(note(5, 'X'));
    const key = onlyDraftKey();
    state().editNoteDraft(key, 'XY');
    expect(await state().backToNotesList()).toBe(false);
    expect(state().notesView).toEqual({ mode: 'editor', draftKey: key });
    expect(state().noteDrafts[key].status).toBe('error');
    expect(state().noteDrafts[key].content).toBe('XY');

    tauriMock.updateNote.mockResolvedValue(note(5, 'XY', 60));
    state().retryNoteDraft(key);
    await vi.advanceTimersByTimeAsync(0);
    expect(state().noteDrafts[key].status).toBe('saved');
  });

  it('releasing an emptied note deletes it', async () => {
    tauriMock.deleteNote.mockResolvedValue(undefined);
    tauriMock.listNotes.mockResolvedValue([note(5, 'X'), note(7, 'Y')]);
    await state().loadNotes(2);
    state().openNoteInPanel(note(5, 'X'));
    state().editNoteDraft(onlyDraftKey(), '');
    expect(await state().backToNotesList()).toBe(true);
    expect(tauriMock.deleteNote).toHaveBeenCalledWith(5);
    expect(tauriMock.updateNote).not.toHaveBeenCalled();
    expect(state().notesLists['project:2']?.notes.map((n) => n.id)).toEqual([7]);
    expect(state().noteDrafts).toEqual({});
  });

  it('releasing an emptied new note drops it without calling the backend', async () => {
    state().startNewNote(2);
    state().editNoteDraft(onlyDraftKey(), ' ');
    expect(await state().backToNotesList()).toBe(true);
    expect(tauriMock.createNote).not.toHaveBeenCalled();
    expect(tauriMock.deleteNote).not.toHaveBeenCalled();
    expect(state().noteDrafts).toEqual({});
  });

  it('saved notes move to the top of their list', async () => {
    tauriMock.listNotes.mockResolvedValue([note(7, 'B', 30), note(5, 'A', 20)]);
    tauriMock.updateNote.mockResolvedValue(note(5, 'A2', 40));
    await state().loadNotes(2);
    state().openNoteInPanel(note(5, 'A', 20));
    const key = onlyDraftKey();
    state().editNoteDraft(key, 'A2');
    await state().flushNoteDraft(key);
    expect(state().notesLists['project:2']?.notes.map((n) => n.id)).toEqual([5, 7]);
    expect(state().notesLists['project:2']?.notes[0].content).toBe('A2');
  });

  it('deleteNoteById removes the note from lists and the panel', async () => {
    tauriMock.deleteNote.mockResolvedValue(undefined);
    tauriMock.listNotes.mockResolvedValue([note(5, 'A'), note(7, 'B')]);
    await state().loadNotes(2);
    state().openNoteInPanel(note(5, 'A'));
    expect(await state().deleteNoteById(5)).toBe(true);
    expect(tauriMock.deleteNote).toHaveBeenCalledWith(5);
    expect(state().notesLists['project:2']?.notes.map((n) => n.id)).toEqual([7]);
    expect(state().noteDrafts).toEqual({});
    expect(state().notesView).toEqual({ mode: 'list' });
  });

  it('deleteNoteById reports an IPC failure and keeps everything', async () => {
    tauriMock.deleteNote.mockRejectedValue(new Error('boom'));
    state().openNoteInPanel(note(5, 'A'));
    expect(await state().deleteNoteById(5)).toBe(false);
    expect(Object.keys(state().noteDrafts)).toHaveLength(1);
    expect(state().notesView.mode).toBe('editor');
  });

  it('reloadNotes refreshes lists and only clean drafts', async () => {
    tauriMock.listNotes.mockResolvedValueOnce([note(5, 'A'), note(7, 'B')]);
    await state().loadNotes(2);
    state().openNoteInPanel(note(5, 'A'));
    state().openNoteInPanel(note(7, 'B'));
    state().editNoteDraft(draftKeyForNote(state(), 5) as string, 'A local');
    tauriMock.listNotes.mockResolvedValueOnce([note(5, 'A remote', 90), note(7, 'B remote', 80)]);
    await state().reloadNotes();
    expect(draftOf(5).content).toBe('A local');
    expect(draftOf(5).savedContent).toBe('A');
    expect(draftOf(7).content).toBe('B remote');
    expect(draftOf(7).savedContent).toBe('B remote');
    expect(state().notesLists['project:2']?.notes.map((n) => n.content)).toEqual(['A remote', 'B remote']);
    expect(state().notesLists['project:2']?.status).toBe('ready');
  });

  it('reloadNotes falls back to getNote for drafts outside loaded lists', async () => {
    state().openNoteInPanel(note(8, 'old', 1, 3));
    tauriMock.getNote.mockResolvedValue(note(8, 'fresh', 5, 3));
    await state().reloadNotes();
    expect(draftOf(8).content).toBe('fresh');
  });

  it('hasUnsavedNotes tracks dirty and saving drafts', async () => {
    const saving = deferred<Note>();
    tauriMock.updateNote.mockReturnValue(saving.promise);
    state().openNoteInPanel(note(5, 'X'));
    const key = onlyDraftKey();
    expect(hasUnsavedNotes(state())).toBe(false);
    state().editNoteDraft(key, 'XY');
    expect(hasUnsavedNotes(state())).toBe(true);
    const flushed = state().flushNoteDraft(key);
    await vi.advanceTimersByTimeAsync(0);
    expect(state().noteDrafts[key].status).toBe('saving');
    expect(hasUnsavedNotes(state())).toBe(true);
    saving.resolve(note(5, 'XY', 70));
    await flushed;
    expect(hasUnsavedNotes(state())).toBe(false);
  });

  it('a blank new draft is not unsaved', () => {
    state().startNewNote(2);
    expect(hasUnsavedNotes(state())).toBe(false);
  });

  it('keeps the draft while another holder shows it', async () => {
    tauriMock.updateNote.mockResolvedValue(note(5, 'XY', 70));
    state().openNoteInPanel(note(5, 'X'));
    const key = onlyDraftKey();
    state().editNoteDraft(key, 'XY');
    expect(await state().releaseNoteDraft(key, { tabId: 'note:5' })).toBe(true);
    expect(tauriMock.updateNote).toHaveBeenCalledWith(5, 'XY');
    expect(state().noteDrafts[key]).toBeDefined();
  });

  it('ensureNoteDraft reuses a draft and loads missing notes', async () => {
    state().openNoteInPanel(note(5, 'X'));
    expect(await state().ensureNoteDraft(5)).toBe(draftKeyForNote(state(), 5));
    expect(tauriMock.getNote).not.toHaveBeenCalled();
    tauriMock.getNote.mockResolvedValue(note(6, 'Z'));
    const key = await state().ensureNoteDraft(6);
    expect(key).not.toBeNull();
    expect(state().noteDrafts[key as string].content).toBe('Z');
    tauriMock.getNote.mockRejectedValue(new Error('gone'));
    expect(await state().ensureNoteDraft(99)).toBeNull();
  });

  it('discardNoteDraft drops only unsaved new drafts and returns to the list', () => {
    state().startNewNote(2);
    const key = onlyDraftKey();
    state().discardNoteDraft(key);
    expect(state().noteDrafts).toEqual({});
    expect(state().notesView).toEqual({ mode: 'list' });
    state().openNoteInPanel(note(5, 'X'));
    state().discardNoteDraft(onlyDraftKey());
    expect(Object.keys(state().noteDrafts)).toHaveLength(1);
  });

  it('closeNotesPanel releases the panel draft and closes', async () => {
    tauriMock.updateNote.mockResolvedValue(note(5, 'XY', 70));
    state().openNotesPanel();
    state().openNoteInPanel(note(5, 'X'));
    state().editNoteDraft(onlyDraftKey(), 'XY');
    expect(await state().closeNotesPanel()).toBe(true);
    expect(state().notesPanelOpen).toBe(false);
    expect(state().notesView).toEqual({ mode: 'list' });
    expect(tauriMock.updateNote).toHaveBeenCalledWith(5, 'XY');
  });

  it('closeNotesPanel stays open when the save fails', async () => {
    tauriMock.updateNote.mockRejectedValue(new Error('boom'));
    useStore.setState({ tabs: [{ kind: 'terminal', id: 't1', projectId: 1, title: 'a' }], activeTabId: 't1' });
    state().openNotesPanel();
    state().openNoteInPanel(note(5, 'X'));
    state().editNoteDraft(onlyDraftKey(), 'XY');
    expect(await state().closeNotesPanel()).toBe(false);
    expect(state().notesPanelOpen).toBe(true);
  });

  it('flushAllNoteDrafts flushes every draft', async () => {
    tauriMock.updateNote.mockResolvedValue(note(5, 'XY', 70));
    state().openNoteInPanel(note(5, 'X'));
    state().editNoteDraft(onlyDraftKey(), 'XY');
    expect(await state().flushAllNoteDrafts()).toBe(true);
    expect(tauriMock.updateNote).toHaveBeenCalledTimes(1);
  });

  it('loadNotes keeps previous notes while loading and on error', async () => {
    tauriMock.listNotes.mockResolvedValueOnce([note(5, 'A')]);
    await state().loadNotes(2);
    const second = deferred<Note[]>();
    tauriMock.listNotes.mockReturnValueOnce(second.promise);
    const loading = state().loadNotes(2);
    expect(state().notesLists['project:2']).toEqual({ status: 'loading', notes: [note(5, 'A')] });
    second.resolve([note(5, 'A'), note(6, 'B')]);
    await loading;
    expect(state().notesLists['project:2']?.notes).toHaveLength(2);
    tauriMock.listNotes.mockRejectedValueOnce(new Error('boom'));
    await state().loadNotes(2);
    expect(state().notesLists['project:2']?.status).toBe('error');
    expect(state().notesLists['project:2']?.notes).toHaveLength(2);
  });

  it('a stale load does not overwrite a newer one', async () => {
    const first = deferred<Note[]>();
    tauriMock.listNotes.mockReturnValueOnce(first.promise);
    tauriMock.listNotes.mockResolvedValueOnce([note(6, 'new')]);
    const slow = state().loadNotes(2);
    await state().loadNotes(2);
    first.resolve([note(5, 'old')]);
    await slow;
    expect(state().notesLists['project:2']?.notes.map((n) => n.id)).toEqual([6]);
  });

  it('reloadNotes keeps text saved while the fetch was in flight', async () => {
    tauriMock.listNotes.mockResolvedValueOnce([note(5, 'A2', 20)]);
    await state().loadNotes(2);
    state().openNoteInPanel(note(5, 'A2', 20));
    const key = onlyDraftKey();
    const fetch = deferred<Note[]>();
    tauriMock.listNotes.mockReturnValueOnce(fetch.promise);
    const reloading = state().reloadNotes();
    tauriMock.updateNote.mockResolvedValue(note(5, 'A23', 40));
    state().editNoteDraft(key, 'A23');
    await state().flushNoteDraft(key);
    fetch.resolve([note(5, 'A2', 20)]);
    await reloading;
    expect(state().noteDrafts[key].content).toBe('A23');
    expect(state().noteDrafts[key].savedContent).toBe('A23');
    expect(state().notesLists['project:2']?.notes[0].content).toBe('A23');
  });

  it('a failed reload does not leave a list stuck in loading', async () => {
    tauriMock.listNotes.mockResolvedValueOnce([note(5, 'A')]);
    await state().loadNotes(2);
    const pending = deferred<Note[]>();
    tauriMock.listNotes.mockReturnValueOnce(pending.promise);
    const loading = state().loadNotes(2);
    tauriMock.listNotes.mockRejectedValueOnce(new Error('boom'));
    await state().reloadNotes();
    pending.resolve([note(5, 'A')]);
    await loading;
    expect(state().notesLists['project:2']?.status).toBe('error');
    expect(state().notesLists['project:2']?.notes.map((n) => n.id)).toEqual([5]);
  });

  it('text typed while a release flushes is saved before the draft is dropped', async () => {
    const firstSave = deferred<Note>();
    tauriMock.updateNote.mockReturnValueOnce(firstSave.promise);
    tauriMock.updateNote.mockResolvedValueOnce(note(5, 'XYZ', 80));
    state().openNoteInPanel(note(5, 'X'));
    const key = onlyDraftKey();
    state().editNoteDraft(key, 'XY');
    const leaving = state().backToNotesList();
    await vi.advanceTimersByTimeAsync(0);
    state().editNoteDraft(key, 'XYZ');
    firstSave.resolve(note(5, 'XY', 70));
    expect(await leaving).toBe(true);
    expect(tauriMock.updateNote).toHaveBeenNthCalledWith(1, 5, 'XY');
    expect(tauriMock.updateNote).toHaveBeenNthCalledWith(2, 5, 'XYZ');
    expect(state().noteDrafts).toEqual({});
    expect(state().notesView).toEqual({ mode: 'list' });
  });

  it('text typed into an emptied note while releasing prevents its deletion', async () => {
    const inFlight = deferred<Note>();
    tauriMock.updateNote.mockReturnValueOnce(inFlight.promise);
    tauriMock.updateNote.mockResolvedValueOnce(note(5, 'Z', 80));
    state().openNoteInPanel(note(5, 'X'));
    const key = onlyDraftKey();
    state().editNoteDraft(key, 'XY');
    await vi.advanceTimersByTimeAsync(700);
    state().editNoteDraft(key, '');
    const leaving = state().backToNotesList();
    state().editNoteDraft(key, 'Z');
    inFlight.resolve(note(5, 'XY', 70));
    expect(await leaving).toBe(true);
    expect(tauriMock.deleteNote).not.toHaveBeenCalled();
    expect(tauriMock.updateNote).toHaveBeenLastCalledWith(5, 'Z');
    expect(state().noteDrafts).toEqual({});
  });

  it('text typed while an emptied note is being deleted is kept as a new note', async () => {
    const deletion = deferred<void>();
    tauriMock.deleteNote.mockReturnValueOnce(deletion.promise);
    tauriMock.createNote.mockResolvedValueOnce(note(11, 'Q', 90));
    state().openNoteInPanel(note(5, 'X'));
    const key = onlyDraftKey();
    state().editNoteDraft(key, '');
    const leaving = state().backToNotesList();
    await vi.advanceTimersByTimeAsync(0);
    state().editNoteDraft(key, 'Q');
    deletion.resolve();
    expect(await leaving).toBe(true);
    expect(tauriMock.createNote).toHaveBeenCalledWith(2, 'Q');
    expect(state().noteDrafts).toEqual({});
  });

  it('openNoteInTab saves a new note first and opens its tab', async () => {
    tauriMock.createNote.mockResolvedValue(note(9, 'Klient\nx', 100));
    state().startNewNote(2);
    const key = onlyDraftKey();
    state().editNoteDraft(key, 'Klient\nx');
    expect(await state().openNoteInTab(key)).toBe(true);
    expect(tauriMock.createNote).toHaveBeenCalledWith(2, 'Klient\nx');
    expect(state().tabs).toContainEqual({ kind: 'note', id: 'note:9', projectId: 2, noteId: 9, title: 'Klient' });
    expect(state().activeTabId).toBe('note:9');
    expect(state().notesView).toEqual({ mode: 'list' });
    expect(state().noteDrafts[key]).toBeDefined();
  });

  it('openNoteInTab refuses a blank new note', async () => {
    state().startNewNote(2);
    const key = onlyDraftKey();
    expect(await state().openNoteInTab(key)).toBe(false);
    expect(state().tabs).toEqual([]);
    expect(state().notesView).toEqual({ mode: 'editor', draftKey: key });
  });

  it('openNoteInTab reports a failed save', async () => {
    tauriMock.createNote.mockRejectedValue(new Error('disk'));
    state().startNewNote(2);
    const key = onlyDraftKey();
    state().editNoteDraft(key, 'Klient');
    expect(await state().openNoteInTab(key)).toBe(false);
    expect(state().tabs).toEqual([]);
  });

  it('openNoteInTab puts a global note in the active project', async () => {
    useStore.setState({ tabs: [{ kind: 'terminal', id: 't1', projectId: 3, title: 'a' }], activeTabId: 't1' });
    state().openNoteInPanel(note(5, 'Globalna', 50, null));
    const key = onlyDraftKey();
    expect(await state().openNoteInTab(key)).toBe(true);
    expect(state().tabs.find((t) => t.id === 'note:5')).toMatchObject({ kind: 'note', projectId: 3, noteId: 5 });
  });

  it('editing renames the note tab', () => {
    state().openNoteInPanel(note(5, 'Stary tytuł'));
    useStore.setState({ tabs: [{ kind: 'note', id: 'note:5', projectId: 2, noteId: 5, title: 'Stary tytuł' }] });
    state().editNoteDraft(onlyDraftKey(), 'Nowy tytuł\nreszta');
    expect(state().tabs.find((t) => t.id === 'note:5')?.title).toBe('Nowy tytuł');
  });

  it('a successful create renames the note tab', async () => {
    tauriMock.createNote.mockResolvedValue(note(9, 'Tytuł', 100));
    useStore.setState({ tabs: [{ kind: 'note', id: 'note:9', projectId: 2, noteId: 9, title: 'Stary' }] });
    state().startNewNote(2);
    const key = onlyDraftKey();
    state().editNoteDraft(key, 'Tytuł');
    await state().flushNoteDraft(key);
    expect(state().tabs.find((t) => t.id === 'note:9')?.title).toBe('Tytuł');
  });

  it('closing the last view of an emptied note deletes it', async () => {
    tauriMock.getNote.mockResolvedValue(note(5, 'X'));
    tauriMock.deleteNote.mockResolvedValue(undefined);
    const key = (await state().ensureNoteDraft(5)) as string;
    useStore.setState({ tabs: [{ kind: 'note', id: 'note:5', projectId: 2, noteId: 5, title: 'X' }] });
    state().editNoteDraft(key, '');
    expect(await state().releaseNoteDraft(key, { tabId: 'note:5' })).toBe(true);
    expect(tauriMock.deleteNote).toHaveBeenCalledWith(5);
  });

  it('release keeps a draft another view still shows', async () => {
    tauriMock.updateNote.mockResolvedValue(note(5, '', 200));
    state().openNoteInPanel(note(5, 'X'));
    const key = onlyDraftKey();
    useStore.setState({ tabs: [{ kind: 'note', id: 'note:5', projectId: 2, noteId: 5, title: 'X' }] });
    state().editNoteDraft(key, '');
    expect(await state().releaseNoteDraft(key, 'panel')).toBe(true);
    expect(tauriMock.deleteNote).not.toHaveBeenCalled();
    expect(state().noteDrafts[key]).toBeDefined();
    expect(await state().releaseNoteDraft(key, { tabId: 'note:5' })).toBe(true);
    expect(tauriMock.deleteNote).not.toHaveBeenCalled();
    expect(state().noteDrafts[key]).toBeDefined();
  });

  it('deleteNoteById closes the note tabs', async () => {
    tauriMock.deleteNote.mockResolvedValue(undefined);
    useStore.setState({
      tabs: [
        { kind: 'note', id: 'note:5', projectId: 2, noteId: 5, title: 'X' },
        { kind: 'terminal', id: 't1', projectId: 2, title: 'a' },
      ],
      activeTabId: 'note:5',
    });
    expect(await state().deleteNoteById(5)).toBe(true);
    expect(state().tabs.map((t) => t.id)).toEqual(['t1']);
  });

  it('the panel closes when no tab is left', () => {
    useStore.setState({ tabs: [{ kind: 'terminal', id: 't1', projectId: 1, title: 'a' }], activeTabId: 't1' });
    state().openNotesPanel();
    expect(state().notesPanelOpen).toBe(true);
    useStore.setState({ tabs: [], activeTabId: null });
    expect(state().notesPanelOpen).toBe(false);
  });
});
