import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { ClickUpTaskDetail } from '../../types/ClickUpTaskDetail';
import { Icon } from '../shared/Icon';
import { ClickUpSummaryDialog } from './ClickUpSummaryDialog';

export function ClickUpTaskDialog({ projectId, taskId, onClose }: { projectId: number; taskId: string; onClose: () => void }) {
  const activeAgentPtyId = useStore(s => s.activeAgentPtyId);
  const unlinkTask = useStore(s => s.unlinkTask);
  const [detail, setDetail] = useState<ClickUpTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const load = async () => {
    setError(null);
    try {
      setDetail(await tauri.clickupGetTask(taskId));
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await tauri.clickupGetTask(taskId);
        if (!cancelled) setDetail(d);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  const handle = async () => {
    setBusy(true);
    try {
      const rel = await tauri.clickupWriteTaskFile(projectId, taskId);
      return `@${rel}`;
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async () => {
    await tauri.writeClipboardText(await handle());
  };

  const onInject = async () => {
    if (!activeAgentPtyId) return;
    const text = await handle();
    const enc = btoa(unescape(encodeURIComponent(text)));
    await tauri.ptyWrite(activeAgentPtyId, enc);
  };

  const onUnlink = async () => {
    await unlinkTask(projectId, taskId);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-bg-elev border border-border w-[640px] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2 min-w-0 text-[12.5px]">
            {detail ? (
              <>
                {detail.customId && <span className="text-muted font-mono shrink-0">{detail.customId}</span>}
                <span className="text-fg truncate">{detail.name}</span>
              </>
            ) : (
              <span className="text-muted">Ładowanie…</span>
            )}
          </div>
          <button onClick={onClose} className="text-muted hover:text-fg transition-colors">
            <Icon name="close" className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-5 text-[12px] text-fg">
          {error && <p className="text-danger">{error}</p>}
          {detail && (
            <>
              {detail.status && <p className="text-fg-secondary mb-3">Status: {detail.status}</p>}
              <pre className="whitespace-pre-wrap font-sans mb-4">{detail.description || '(brak opisu)'}</pre>
              {detail.attachments.length > 0 && (
                <div className="mb-4">
                  <p className="text-muted uppercase text-[10px] tracking-wider mb-1">Załączniki</p>
                  {detail.attachments.map(a => (
                    <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="block text-accent hover:underline">{a.title}</a>
                  ))}
                </div>
              )}
              {detail.comments.length > 0 && (
                <div>
                  <p className="text-muted uppercase text-[10px] tracking-wider mb-1">Komentarze</p>
                  {detail.comments.map(c => (
                    <p key={c.id} className="mb-2"><span className="text-fg-secondary">{c.user}:</span> {c.text}</p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-border">
          <button disabled={busy} onClick={onCopy} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg disabled:opacity-40">Kopiuj uchwyt</button>
          <button disabled={busy || !activeAgentPtyId} onClick={onInject} title={activeAgentPtyId ? '' : 'Brak aktywnej sesji'} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg disabled:opacity-40">Wstaw do aktywnej sesji</button>
          <button disabled={busy} onClick={load} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg disabled:opacity-40">Odśwież</button>
          <div className="flex-1" />
          <button disabled={busy} onClick={() => setSummaryOpen(true)} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Generuj podsumowanie</button>
          <button onClick={onUnlink} className="px-3 py-1.5 border border-border text-[12px] text-danger hover:text-danger">Odepnij</button>
        </div>
      </div>
      {summaryOpen && <ClickUpSummaryDialog projectId={projectId} taskId={taskId} onClose={() => setSummaryOpen(false)} />}
    </div>
  );
}
