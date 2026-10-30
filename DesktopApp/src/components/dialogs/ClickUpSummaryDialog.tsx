import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { selectActiveSession } from '../../store/tabsSlice';
import { tauri } from '../../lib/tauri';

export function ClickUpSummaryDialog({ projectId, taskId, onClose }: { projectId: number; taskId: string; onClose: () => void }) {
  const activeSession = useStore(useShallow(selectActiveSession));
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
    <div className="dialog-backdrop" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="dialog-panel w-[640px] max-h-[80vh] flex flex-col p-4 gap-3" onClick={e => e.stopPropagation()}>
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">PODSUMOWANIE PRAC</span>
        {error && <p className="text-[11px] text-danger">{error}</p>}
        {busy && !text && <p className="text-[11px] text-muted">Generuję podsumowanie…</p>}
        <textarea value={text} onChange={e => setText(e.target.value)} rows={12}
          className="field text-[12px] font-mono resize-none" />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Anuluj</button>
          <button disabled={busy || !text.trim()} onClick={post}
            className="btn-primary">Wyślij jako komentarz</button>
        </div>
      </div>
    </div>
  );
}
