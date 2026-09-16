import { describe, expect, it } from 'vitest';
import type { Note } from '../../types';
import { emptyNoteDraft, isNoteDraftDirty, noteToDraft } from './noteDraft';

const note: Note = {
  id: 5,
  projectId: 2,
  title: 'Plan',
  content: 'Treść',
  createdAt: 10,
  updatedAt: 20,
};

describe('note drafts', () => {
  it('creates a clean draft from a note', () => {
    const draft = noteToDraft(note);
    expect(draft).toEqual({ id: 5, title: 'Plan', content: 'Treść', savedTitle: 'Plan', savedContent: 'Treść' });
    expect(isNoteDraftDirty(draft)).toBe(false);
  });

  it('detects changed title or content', () => {
    expect(isNoteDraftDirty({ ...noteToDraft(note), title: 'Nowy plan' })).toBe(true);
    expect(isNoteDraftDirty({ ...noteToDraft(note), content: 'Nowa treść' })).toBe(true);
  });

  it('creates a clean unsaved draft', () => {
    expect(emptyNoteDraft()).toEqual({ id: null, title: '', content: '', savedTitle: '', savedContent: '' });
    expect(isNoteDraftDirty(emptyNoteDraft())).toBe(false);
    expect(isNoteDraftDirty(null)).toBe(false);
  });
});
