import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';
import type { Note } from '../../types';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { NoteList } from './NoteList';
import { NoteEditor } from './NoteEditor';
import { emptyNoteDraft, isNoteDraftDirty, noteToDraft, type NoteDraft } from './noteDraft';

type NotesWorkspaceProps = {
  projectId: number;
  onDirtyChange: (dirty: boolean) => void;
};

export function NotesWorkspace({ projectId, onDirtyChange }: NotesWorkspaceProps) {
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [{ notes, draft }, setWorkspace] = useState<{ notes: Note[]; draft: NoteDraft | null }>({ notes: [], draft: null });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [noteToDelete, setNoteToDelete] = useState<Note | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletedIds = useRef(new Set<number>());
  const projectIdForScope = scope === 'project' ? projectId : null;

  const loadNotes = useCallback((isCancelled: () => boolean) => {
    setLoading(true);
    setLoadError(false);
    setWorkspace(current => ({ ...current, notes: [] }));
    deletedIds.current.clear();
    void tauri.listNotes(projectIdForScope).then(result => {
      if (!isCancelled()) {
        setWorkspace(current => {
          const savedIds = new Set(current.notes.map(note => note.id));
          return {
            ...current,
            notes: [...current.notes, ...result.filter(note => !savedIds.has(note.id) && !deletedIds.current.has(note.id))],
          };
        });
      }
    }).catch(() => {
      if (!isCancelled()) setLoadError(true);
    }).finally(() => {
      if (!isCancelled()) setLoading(false);
    });
  }, [projectIdForScope]);

  useEffect(() => {
    let cancelled = false;
    loadNotes(() => cancelled);
    return () => { cancelled = true; };
  }, [loadNotes, loadAttempt]);

  useEffect(() => {
    onDirtyChange(isNoteDraftDirty(draft));
  }, [draft, onDirtyChange]);

  const requestDiscard = (action: () => void) => {
    if (saving || deleting || pendingAction || noteToDelete) return;
    if (!isNoteDraftDirty(draft)) {
      action();
      return;
    }
    setPendingAction(() => action);
  };

  const changeScope = (nextScope: 'project' | 'global') => {
    if (scope === nextScope) return;
    requestDiscard(() => {
      setWorkspace(current => ({ ...current, draft: null }));
      setScope(nextScope);
    });
  };

  const save = async () => {
    if (!draft || saving || deleting || pendingAction || noteToDelete || !draft.title.trim()) return;
    setSaving(true);
    try {
      const title = draft.title.trim();
      const saved = draft.id === null
        ? await tauri.createNote(projectIdForScope, title, draft.content)
        : await tauri.updateNote(draft.id, title, draft.content);
      setWorkspace(current => ({
        draft: noteToDraft(saved),
        notes: [saved, ...current.notes.filter(note => note.id !== saved.id)],
      }));
      toast.success('Notatka została zapisana');
    } catch (error) {
      toast.error(`Nie udało się zapisać notatki: ${formatTauriError(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const requestDelete = (note: Note) => {
    if (saving || deleting || pendingAction || noteToDelete) return;
    if (draft?.id === note.id) {
      requestDiscard(() => setNoteToDelete(note));
    } else {
      setNoteToDelete(note);
    }
  };

  const deleteNote = async () => {
    if (!noteToDelete || deleting) return;
    setDeleting(true);
    try {
      await tauri.deleteNote(noteToDelete.id);
      deletedIds.current.add(noteToDelete.id);
      setWorkspace(current => {
        const remaining = current.notes.filter(note => note.id !== noteToDelete.id)
          .sort((first, second) => second.updatedAt - first.updatedAt || second.id - first.id);
        return {
          notes: remaining,
          draft: current.draft?.id === noteToDelete.id
            ? remaining.length > 0 ? noteToDraft(remaining[0]) : null
            : current.draft,
        };
      });
      setNoteToDelete(null);
    } catch {
      toast.error('Nie udało się usunąć notatki');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <fieldset
        disabled={saving || deleting || pendingAction !== null || noteToDelete !== null}
        className="m-0 flex h-full min-h-0 min-w-0 flex-col border-0 p-0"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div role="tablist" aria-label="Zakres notatek" className="flex gap-1">
            {(['project', 'global'] as const).map(tabScope => (
              <button
                key={tabScope}
                type="button"
                role="tab"
                aria-selected={scope === tabScope}
                onClick={() => changeScope(tabScope)}
                className={`px-3 py-1.5 text-[12px] ${scope === tabScope ? 'bg-bg-elev text-fg' : 'text-muted hover:text-fg'}`}
              >
                {tabScope === 'project' ? 'Projektowe' : 'Globalne'}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => requestDiscard(() => setWorkspace(current => ({ ...current, draft: emptyNoteDraft() })))}
            className="border border-border px-3 py-1.5 text-[12px] hover:bg-bg-elev disabled:opacity-50"
          >
            Nowa notatka
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <aside aria-label="Lista notatek" className="flex w-72 shrink-0 flex-col border-r border-border">
            <NoteList
              scope={scope}
              notes={notes}
              selectedId={draft?.id ?? null}
              loading={loading}
              error={loadError}
              onOpen={note => {
                if (draft?.id !== note.id) {
                  requestDiscard(() => setWorkspace(current => ({ ...current, draft: noteToDraft(note) })));
                }
              }}
              onDelete={requestDelete}
              onRetry={() => setLoadAttempt(current => current + 1)}
            />
          </aside>
          <NoteEditor
            draft={draft}
            saving={saving}
            onChange={patch => setWorkspace(current => ({
              ...current,
              draft: current.draft ? { ...current.draft, ...patch } : null,
            }))}
            onSave={() => { void save(); }}
            onDelete={() => {
              const selectedNote = notes.find(note => note.id === draft?.id);
              if (selectedNote) requestDelete(selectedNote);
            }}
          />
        </div>
      </fieldset>
      {pendingAction && (
        <ConfirmDialog
          title="Odrzucić niezapisane zmiany?"
          message="Masz niezapisane zmiany w notatce. Odrzucić je i kontynuować?"
          confirmLabel="Odrzuć"
          onConfirm={() => {
            setPendingAction(null);
            pendingAction();
          }}
          onCancel={() => setPendingAction(null)}
        />
      )}
      {noteToDelete && (
        <fieldset disabled={deleting} className="contents">
          <ConfirmDialog
            title="Usuń notatkę"
            message={`Usunąć notatkę „${noteToDelete.title}”? Tej operacji nie można cofnąć.`}
            confirmLabel="Usuń"
            onConfirm={() => { void deleteNote(); }}
            onCancel={() => { if (!deleting) setNoteToDelete(null); }}
          />
        </fieldset>
      )}
    </>
  );
}
