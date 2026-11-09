import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useStore } from '../../store';
import type { Tab } from '../../store/tabsSlice';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { IconBtn } from '../shared/IconBtn';
import { NoteEditor } from './NoteEditor';

type Props = {
  tab: Extract<Tab, { kind: 'note' }>;
  visible: boolean;
  focused: boolean;
};

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; draftKey: string };

export function NoteTabView({ tab, visible, focused }: Props) {
  const ensureNoteDraft = useStore(state => state.ensureNoteDraft);
  const deleteNoteById = useStore(state => state.deleteNoteById);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const draftKey = load.status === 'ready' ? load.draftKey : null;
  const draft = useStore(state => (draftKey === null ? undefined : state.noteDrafts[draftKey]));

  useEffect(() => {
    let cancelled = false;
    void ensureNoteDraft(tab.noteId).then(key => {
      if (!cancelled) setLoad(key === null ? { status: 'error' } : { status: 'ready', draftKey: key });
    });
    return () => { cancelled = true; };
  }, [ensureNoteDraft, tab.noteId]);

  const confirmDelete = async () => {
    setConfirmingDelete(false);
    if (!(await deleteNoteById(tab.noteId))) toast.error('Nie udało się usunąć notatki');
  };

  if (load.status === 'error') {
    return <div className="grid h-full place-items-center text-[13px] text-muted">Nie udało się wczytać notatki.</div>;
  }
  if (draftKey === null || !draft) {
    return <div className="grid h-full place-items-center text-[13px] text-muted">Wczytywanie notatki…</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-4">
      <div className="mx-auto flex w-full max-w-[72ch] items-center gap-1.5">
        <span className="mr-auto px-0.5 text-[11px] uppercase tracking-[0.06em] text-muted">
          {draft.projectId === null ? 'Notatka globalna' : 'Notatka projektowa'}
        </span>
        <IconBtn icon="trash" label="Usuń notatkę" tone="ghost" onClick={() => setConfirmingDelete(true)} />
      </div>
      <NoteEditor draftKey={draftKey} variant="tab" autoFocus={visible && focused} />
      {confirmingDelete && (
        <ConfirmDialog
          title="Usuń notatkę"
          message="Usunąć tę notatkę? Tej operacji nie można cofnąć."
          confirmLabel="Usuń"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
