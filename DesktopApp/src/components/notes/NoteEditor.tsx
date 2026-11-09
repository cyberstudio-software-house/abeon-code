import { useEffect, useRef } from 'react';
import { useStore } from '../../store';

type Props = {
  draftKey: string;
  variant: 'panel' | 'tab';
  autoFocus: boolean;
};

export function NoteEditor({ draftKey, variant, autoFocus }: Props) {
  const draft = useStore(state => state.noteDrafts[draftKey]);
  const editNoteDraft = useStore(state => state.editNoteDraft);
  const retryNoteDraft = useStore(state => state.retryNoteDraft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const caretPlacedFor = useRef<string | null>(null);
  const present = draft !== undefined;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element || !autoFocus) return;
    element.focus();
    if (caretPlacedFor.current === draftKey) return;
    element.setSelectionRange(element.value.length, element.value.length);
    caretPlacedFor.current = draftKey;
  }, [draftKey, present, autoFocus]);

  if (!draft) return null;

  const isTab = variant === 'tab';

  return (
    <div className={`flex min-h-0 flex-1 flex-col gap-1.5 ${isTab ? 'mx-auto w-full max-w-[72ch]' : ''}`}>
      <textarea
        ref={textareaRef}
        aria-label="Treść notatki"
        placeholder="Zacznij pisać…"
        value={draft.content}
        onChange={event => editNoteDraft(draftKey, event.target.value)}
        className={`min-h-0 flex-1 resize-none rounded-[9px] border border-accent bg-bg-elev p-2.5 text-fg outline-none placeholder:text-muted ${isTab ? 'text-[14px]' : 'text-[13px]'}`}
      />
      <div className="flex h-5 shrink-0 items-center gap-2 px-0.5 text-[10.5px]">
        {draft.status === 'saving' && <span className="text-muted">Zapisywanie…</span>}
        {draft.status === 'saved' && <span className="text-success">✓ Zapisano</span>}
        {draft.status === 'error' && (
          <>
            <span className="text-danger">Nie udało się zapisać</span>
            <button type="button" className="text-fg-secondary underline hover:text-fg" onClick={() => retryNoteDraft(draftKey)}>
              Ponów
            </button>
          </>
        )}
      </div>
    </div>
  );
}
