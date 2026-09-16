import { useId } from 'react';
import type { NoteDraft } from './noteDraft';

type NoteEditorProps = {
  draft: NoteDraft | null;
  saving: boolean;
  onChange: (patch: Partial<Pick<NoteDraft, 'title' | 'content'>>) => void;
  onSave: () => void;
  onDelete: () => void;
};

export function NoteEditor({ draft, saving, onChange, onSave, onDelete }: NoteEditorProps) {
  const titleId = useId();
  const contentId = useId();

  if (draft === null) {
    return <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted">Otwórz notatkę z listy lub utwórz nową.</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <label htmlFor={titleId} className="text-[11px] text-muted">Tytuł</label>
      <input
        id={titleId}
        value={draft.title}
        disabled={saving}
        onChange={event => onChange({ title: event.target.value })}
        className="w-full border border-border bg-bg px-3 py-2 text-[13px]"
      />
      <label htmlFor={contentId} className="text-[11px] text-muted">Treść</label>
      <textarea
        id={contentId}
        value={draft.content}
        disabled={saving}
        onChange={event => onChange({ content: event.target.value })}
        className="min-h-0 w-full flex-1 resize-none border border-border bg-bg p-3 text-[13px] leading-relaxed"
      />
      <div className="flex items-center justify-end gap-2">
        {draft.id !== null && (
          <button type="button" onClick={onDelete} disabled={saving} className="mr-auto border border-border px-3 py-1.5 text-[12px] disabled:opacity-50">
            Usuń
          </button>
        )}
        {saving && <span role="status" className="text-[12px] text-muted">Zapisywanie…</span>}
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !draft.title.trim()}
          className="bg-fg px-3 py-1.5 text-[12px] font-medium text-bg disabled:opacity-50"
        >
          Zapisz
        </button>
      </div>
    </div>
  );
}
