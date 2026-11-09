import type { Note } from '../../types';
import { formatNoteDate } from '../../lib/noteText';
import type { NotesList } from '../../store/notesSlice';

type Props = {
  list: NotesList | undefined;
  emptyLabel: string;
  onOpen: (note: Note) => void;
  onRetry: () => void;
};

export function NoteTiles({ list, emptyLabel, onOpen, onRetry }: Props) {
  const notes = list?.notes ?? [];
  const now = Date.now();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
      {(!list || (list.status === 'loading' && notes.length === 0)) && (
        <div className="px-1 text-[12px] text-muted">Ładowanie notatek…</div>
      )}
      {list?.status === 'error' && (
        <div className="flex items-center gap-2 px-1 text-[12px] text-muted">
          <span>Nie udało się wczytać notatek.</span>
          <button type="button" className="btn-secondary" onClick={onRetry}>Spróbuj ponownie</button>
        </div>
      )}
      {list?.status === 'ready' && notes.length === 0 && (
        <div className="px-1 text-[12px] text-muted">{emptyLabel}</div>
      )}
      {notes.map(note => (
        <button
          key={note.id}
          type="button"
          onClick={() => onOpen(note)}
          className="block w-full shrink-0 rounded-[9px] border border-border bg-bg-elev px-2.5 py-2 text-left transition-colors hover:border-border-strong hover:bg-bg-elev-2"
        >
          <span className="line-clamp-4 block whitespace-pre-line break-words text-[12.5px] text-fg-secondary">{note.content}</span>
          <time className="mt-1.5 block text-[10px] text-muted">{formatNoteDate(note.updatedAt, now)}</time>
        </button>
      ))}
    </div>
  );
}
