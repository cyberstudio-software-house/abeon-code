import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { notesListKey } from '../../lib/noteText';
import { useStore } from '../../store';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { Icon } from '../shared/Icon';
import { IconBtn } from '../shared/IconBtn';
import { TabButton } from '../shared/TabButton';
import { NoteEditor } from './NoteEditor';
import { NoteTiles } from './NoteTiles';

function NotesListView({ projectId }: { projectId: number | null }) {
  const scope = useStore(state => state.notesScope);
  const notesLists = useStore(state => state.notesLists);
  const setNotesScope = useStore(state => state.setNotesScope);
  const loadNotes = useStore(state => state.loadNotes);
  const startNewNote = useStore(state => state.startNewNote);
  const openNoteInPanel = useStore(state => state.openNoteInPanel);
  const closeNotesPanel = useStore(state => state.closeNotesPanel);

  const isProjectScope = scope === 'project';
  const hasScopeTarget = !isProjectScope || projectId !== null;
  const listProjectId = isProjectScope ? projectId : null;
  const listKey = notesListKey(listProjectId);
  const list = hasScopeTarget ? notesLists[listKey] : { status: 'ready' as const, notes: [] };
  const needsLoad = hasScopeTarget && list === undefined;

  useEffect(() => {
    if (needsLoad) void loadNotes(listProjectId);
  }, [needsLoad, listProjectId, loadNotes]);

  const close = async () => {
    if (!(await closeNotesPanel())) toast.error('Nie udało się zapisać notatki');
  };

  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className="mr-auto px-0.5 text-[11px] uppercase tracking-[0.06em] text-muted">Notatki</span>
        <button
          type="button"
          aria-label="Nowa notatka"
          disabled={!hasScopeTarget}
          onClick={() => startNewNote(listProjectId)}
          className="btn-primary h-7 px-2.5 text-[12px]"
        >
          + Nowa
        </button>
        <IconBtn icon="close" label="Zamknij panel notatek" tone="ghost" onClick={() => void close()} />
      </div>
      <div role="tablist" aria-label="Zakres notatek" className="grid grid-cols-2 gap-0.5 rounded-lg border border-border bg-sunken p-0.5">
        <TabButton active={isProjectScope} onClick={() => setNotesScope('project')} className="h-6 text-[12px]">Projektowe</TabButton>
        <TabButton active={!isProjectScope} onClick={() => setNotesScope('global')} className="h-6 text-[12px]">Globalne</TabButton>
      </div>
      <NoteTiles
        list={list}
        emptyLabel={isProjectScope ? 'Brak notatek projektowych' : 'Brak notatek globalnych'}
        onOpen={openNoteInPanel}
        onRetry={() => void loadNotes(listProjectId)}
      />
    </>
  );
}

function NotesEditorView({ draftKey, noteId }: { draftKey: string; noteId: number | null }) {
  const backToNotesList = useStore(state => state.backToNotesList);
  const discardNoteDraft = useStore(state => state.discardNoteDraft);
  const deleteNoteById = useStore(state => state.deleteNoteById);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const back = async () => {
    if (!(await backToNotesList())) toast.error('Nie udało się zapisać notatki');
  };

  const requestDelete = () => {
    if (noteId === null) discardNoteDraft(draftKey);
    else setConfirmingDelete(true);
  };

  const confirmDelete = async () => {
    setConfirmingDelete(false);
    if (noteId !== null && !(await deleteNoteById(noteId))) toast.error('Nie udało się usunąć notatki');
  };

  return (
    <>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Wróć do listy notatek"
          onClick={() => void back()}
          className="btn-secondary h-7 px-2.5 text-[12px]"
        >
          <Icon name="arrowLeft" className="h-3 w-3" />
          Notatki
        </button>
        <span className="flex-1" />
        <IconBtn icon="trash" label="Usuń notatkę" tone="ghost" onClick={requestDelete} />
      </div>
      <NoteEditor draftKey={draftKey} variant="panel" />
      {confirmingDelete && (
        <ConfirmDialog
          title="Usuń notatkę"
          message="Usunąć tę notatkę? Tej operacji nie można cofnąć."
          confirmLabel="Usuń"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </>
  );
}

export function NotesPanel() {
  const view = useStore(state => state.notesView);
  const draftKey = view.mode === 'editor' ? view.draftKey : null;
  const draft = useStore(state => (draftKey === null ? undefined : state.noteDrafts[draftKey]));
  const tabs = useStore(state => state.tabs);
  const activeTabId = useStore(state => state.activeTabId);
  const projectId = tabs.find(tab => tab.id === activeTabId)?.projectId ?? null;

  return (
    <section aria-label="Notatki" className="flex min-h-0 flex-1 flex-col gap-2 rounded-[10px] border border-border bg-bg p-2">
      {draftKey !== null && draft
        ? <NotesEditorView key={draftKey} draftKey={draftKey} noteId={draft.noteId} />
        : <NotesListView projectId={projectId} />}
    </section>
  );
}
