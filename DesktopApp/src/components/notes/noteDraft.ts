import type { Note } from '../../types';

export type NoteDraft = {
  id: number | null;
  title: string;
  content: string;
  savedTitle: string;
  savedContent: string;
};

export const emptyNoteDraft = (): NoteDraft => ({
  id: null,
  title: '',
  content: '',
  savedTitle: '',
  savedContent: '',
});

export const noteToDraft = (note: Note): NoteDraft => ({
  id: note.id,
  title: note.title,
  content: note.content,
  savedTitle: note.title,
  savedContent: note.content,
});

export const isNoteDraftDirty = (draft: NoteDraft | null): boolean =>
  draft !== null && (draft.title !== draft.savedTitle || draft.content !== draft.savedContent);
