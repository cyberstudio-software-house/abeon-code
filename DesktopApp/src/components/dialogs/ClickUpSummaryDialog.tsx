import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { selectActiveSession } from '../../store/tabsSlice';
import { tauri } from '../../lib/tauri';

export function ClickUpSummaryDialog({ projectId, taskId, onClose }: { projectId: number; taskId: string; onClose: () => void }) {
  const activeSession = useStore(selectActiveSession);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeSession) { setError('Brak aktywnej sesji.'); return; }
    let cancelled = false;
    setBusy(true);
    tauri.clickupGenerateSummary(projectId, activeSession.sessionId, activeSession.provider)
      .then(s => { if (!cancelled) setText(s); })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [projectId, activeSession]);

  const post = async () => {
    setBusy(true);
    try { await tauri.clickupPostComment(taskId, text); onClose(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-bg-elev border border-border w-[640px] max-h-[80vh] flex flex-col p-4 gap-3" onClick={e => e.stopPropagation()}>
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">PODSUMOWANIE PRAC</span>
        {error && <p className="text-[11px] text-danger">{error}</p>}
        {busy && !text && <p className="text-[11px] text-muted">Generuję podsumowanie…</p>}
        <textarea value={text} onChange={e => setText(e.target.value)} rows={12}
          className="w-full bg-bg border border-border px-3 py-2 text-[12px] font-mono resize-none" />
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg" onClick={onClose}>Anuluj</button>
          <button disabled={busy || !text.trim()} onClick={post}
            className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium disabled:opacity-50">Wyślij jako komentarz</button>
        </div>
      </div>
    </div>
  );
}
