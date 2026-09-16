import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';
import type { Note } from '../../types';
import { NoteList } from './NoteList';
import { NoteEditor } from './NoteEditor';
import { emptyNoteDraft, isNoteDraftDirty, noteToDraft, type NoteDraft } from './noteDraft';

type NotesWorkspaceProps = {
  projectId: number;
  onDirtyChange: (dirty: boolean) => void;
};

export function NotesWorkspace({ projectId, onDirtyChange }: NotesWorkspaceProps) {
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const projectIdForScope = scope === 'project' ? projectId : null;

  const loadNotes = useCallback((isCancelled: () => boolean) => {
    setLoading(true);
    setLoadError(false);
    setNotes([]);
    void tauri.listNotes(projectIdForScope).then(result => {
      if (!isCancelled()) setNotes(result);
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

  const changeScope = (nextScope: 'project' | 'global') => {
    if (scope === nextScope || saving) return;
    setDraft(null);
    setScope(nextScope);
  };

  const save = async () => {
    if (!draft || saving || !draft.title.trim()) return;
    setSaving(true);
    try {
      const title = draft.title.trim();
      const saved = draft.id === null
        ? await tauri.createNote(projectIdForScope, title, draft.content)
        : await tauri.updateNote(draft.id, title, draft.content);
      setDraft(noteToDraft(saved));
      setNotes(current => [saved, ...current.filter(note => note.id !== saved.id)]);
      toast.success('Notatka została zapisana');
    } catch (error) {
      toast.error(`Nie udało się zapisać notatki: ${formatTauriError(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteNote = () => {};

  return (
    <fieldset disabled={saving} className="m-0 flex h-full min-h-0 min-w-0 flex-col border-0 p-0">
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
          onClick={() => setDraft(emptyNoteDraft())}
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
            onOpen={note => setDraft(noteToDraft(note))}
            onDelete={deleteNote}
            onRetry={() => setLoadAttempt(current => current + 1)}
          />
        </aside>
        <NoteEditor
          draft={draft}
          saving={saving}
          onChange={patch => setDraft(current => current ? { ...current, ...patch } : current)}
          onSave={() => { void save(); }}
          onDelete={deleteNote}
        />
      </div>
    </fieldset>
  );
}
