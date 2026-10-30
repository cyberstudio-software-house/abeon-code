import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { selectActiveSession } from '../../store/tabsSlice';
import { tauri } from '../../lib/tauri';
import type { TimeEstimate } from '../../types/TimeEstimate';

const fmt = (ms: number) => {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

export function ClickUpTimeDialog({ projectId, taskId, onClose }: { projectId: number; taskId: string; onClose: () => void }) {
  const activeSession = useStore(useShallow(selectActiveSession));
  const [est, setEst] = useState<TimeEstimate | null>(null);
  const [blend, setBlend] = useState(0.5);
  const [overrideMin, setOverrideMin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeSession) { setError('Brak aktywnej sesji.'); return; }
    let cancelled = false;
    tauri.clickupEstimateTime(projectId, activeSession.sessionId, activeSession.provider)
      .then(e => { if (!cancelled) setEst(e); })
      .catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [projectId, activeSession]);

  const proposedMs = est ? Math.round(est.sessionMs + blend * (est.devEstimateMs - est.sessionMs)) : 0;
  const overrideMs = overrideMin.trim() ? Math.round(Number(overrideMin) * 60000) : NaN;
  const finalMs = Number.isFinite(overrideMs) ? overrideMs : proposedMs;

  const save = async () => {
    setBusy(true);
    try { await tauri.clickupLogTime(projectId, taskId, finalMs, 'Czas pracy (AbeonCode)'); onClose(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="dialog-panel w-[480px] p-4 space-y-3" onClick={e => e.stopPropagation()}>
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">CZAS PRACY</span>
        {error && <p className="text-[11px] text-danger">{error}</p>}
        {est && (
          <>
            <p className="text-[12px] text-fg-secondary">Czas sesji: <span className="text-fg">{fmt(est.sessionMs)}</span></p>
            <p className="text-[12px] text-fg-secondary">Szacunek dev: <span className="text-fg">{fmt(est.devEstimateMs)}</span></p>
            <label className="block text-[11px] text-muted">Blend (sesja ↔ dev)</label>
            <input type="range" min={0} max={1} step={0.05} value={blend} onChange={e => setBlend(Number(e.target.value))} className="w-full" />
            <p className="text-[12px] text-fg">Propozycja: <span className="font-medium">{fmt(proposedMs)}</span></p>
            <label className="block text-[11px] text-muted">Nadpisz (minuty, opcjonalnie)</label>
            <input value={overrideMin} onChange={e => setOverrideMin(e.target.value)} placeholder={String(Math.round(proposedMs / 60000))}
              className="field font-mono" />
          </>
        )}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Anuluj</button>
          <button disabled={busy || !est} onClick={save} className="btn-primary">Zapisz czas</button>
        </div>
      </div>
    </div>
  );
}
