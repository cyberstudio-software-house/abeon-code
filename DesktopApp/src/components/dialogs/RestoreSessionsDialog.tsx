import { useEffect, useRef } from 'react';

export type RestorableSession = { id: string; title: string; projectName: string | null };

type Props = { sessions: RestorableSession[]; onResume: () => void; onDismiss: () => void };

export function RestoreSessionsDialog({ sessions, onResume, onDismiss }: Props) {
  const resumeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    resumeRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onDismiss(); }
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onDismiss]);
  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border p-5 w-[440px]">
        <h2 className="text-[14px] font-semibold mb-2">Wznowić sesje sprzed zamknięcia?</h2>
        <p className="text-[13px] text-fg-secondary mb-3">
          Te sesje działały w chwili ostatniego zamknięcia programu:
        </p>
        <ul className="mb-4 max-h-56 overflow-auto border border-border">
          {sessions.map(session => (
            <li
              key={session.id}
              className="flex items-baseline gap-2 min-w-0 px-3 py-1.5 text-[12px] border-b border-border last:border-b-0"
            >
              {session.projectName && <span className="text-muted shrink-0">{session.projectName}</span>}
              <span className="text-fg truncate">{session.title}</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button onClick={onDismiss} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">
            Nie teraz
          </button>
          <button ref={resumeRef} onClick={onResume} className="px-3 py-1.5 bg-accent text-accent-fg text-[12px]">
            {sessions.length === 1 ? 'Wznów' : 'Wznów wszystkie'}
          </button>
        </div>
      </div>
    </div>
  );
}
