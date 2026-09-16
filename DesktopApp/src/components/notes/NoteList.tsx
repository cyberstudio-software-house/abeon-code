import type { Note } from '../../types';
import { Icon } from '../shared/Icon';

type NoteListProps = {
  scope: 'project' | 'global';
  notes: Note[];
  selectedId: number | null;
  loading: boolean;
  error: boolean;
  onOpen: (note: Note) => void;
  onDelete: (note: Note) => void;
  onRetry: () => void;
};

const dateFormatter = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short' });

export function NoteList({ scope, notes, selectedId, loading, error, onOpen, onDelete, onRetry }: NoteListProps) {
  if (loading) {
    return <p role="status" className="p-4 text-[12px] text-muted">Ładowanie notatek…</p>;
  }

  if (error) {
    return (
      <div role="alert" className="p-4 text-[12px]">
        <p className="mb-3 text-muted">Nie udało się wczytać notatek.</p>
        <button type="button" onClick={onRetry} className="border border-border px-3 py-1.5 hover:bg-bg-elev">
          Spróbuj ponownie
        </button>
      </div>
    );
  }

  if (notes.length === 0) {
    return <p className="p-4 text-[12px] text-muted">{scope === 'project' ? 'Brak notatek projektowych' : 'Brak notatek globalnych'}</p>;
  }

  return (
    <ul className="min-h-0 overflow-y-auto">
      {notes.map(note => (
        <li
          key={note.id}
          data-testid="note-row"
          className={`flex border-b border-border ${selectedId === note.id ? 'bg-bg-elev' : ''}`}
        >
          <button
            type="button"
            aria-label={`Otwórz ${note.title}`}
            aria-pressed={selectedId === note.id}
            onClick={() => onOpen(note)}
            className="min-w-0 flex-1 px-4 py-3 text-left hover:bg-bg-elev"
          >
            <span className="block truncate text-[13px] font-medium">{note.title}</span>
            <span className="mt-1 block truncate text-[12px] text-fg-secondary">{note.content}</span>
            <time dateTime={new Date(note.updatedAt).toISOString()} className="mt-2 block text-[10px] text-muted">
              {dateFormatter.format(note.updatedAt)}
            </time>
          </button>
          <button
            type="button"
            aria-label={`Usuń ${note.title}`}
            onClick={() => onDelete(note)}
            className="self-start p-3 text-muted hover:text-fg"
          >
            <Icon name="trash" />
          </button>
        </li>
      ))}
    </ul>
  );
}
