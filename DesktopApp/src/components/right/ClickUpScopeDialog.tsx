import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { ClickUpWorkspace } from '../../types/ClickUpWorkspace';
import type { ClickUpSpace } from '../../types/ClickUpSpace';
import type { ClickUpList } from '../../types/ClickUpList';

export function ClickUpScopeDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const loadConfig = useStore(s => s.loadConfig);
  const [workspaces, setWorkspaces] = useState<ClickUpWorkspace[]>([]);
  const [spaces, setSpaces] = useState<ClickUpSpace[]>([]);
  const [lists, setLists] = useState<ClickUpList[]>([]);
  const [ws, setWs] = useState('');
  const [sp, setSp] = useState('');
  const [li, setLi] = useState('');
  const [loadingWs, setLoadingWs] = useState(true);
  const [loadingSp, setLoadingSp] = useState(false);
  const [loadingLi, setLoadingLi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingWs(true);
    setError(null);
    Promise.all([tauri.clickupListWorkspaces(), tauri.clickupGetConfig(projectId)])
      .then(([wss, config]) => {
        if (cancelled) return;
        setWorkspaces(wss);
        if (config) {
          setWs(config.workspaceId);
          setSp(config.spaceId ?? '');
          setLi(config.listId ?? '');
        }
      })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoadingWs(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    if (!ws) { setSpaces([]); return; }
    let cancelled = false;
    setLoadingSp(true);
    tauri.clickupListSpaces(ws)
      .then(s => { if (!cancelled) setSpaces(s); })
      .catch(e => { if (!cancelled) { setSpaces([]); setError(String(e)); } })
      .finally(() => { if (!cancelled) setLoadingSp(false); });
    return () => { cancelled = true; };
  }, [ws]);

  useEffect(() => {
    if (!sp) { setLists([]); return; }
    let cancelled = false;
    setLoadingLi(true);
    tauri.clickupListLists(sp)
      .then(l => { if (!cancelled) setLists(l); })
      .catch(e => { if (!cancelled) { setLists([]); setError(String(e)); } })
      .finally(() => { if (!cancelled) setLoadingLi(false); });
    return () => { cancelled = true; };
  }, [sp]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await tauri.clickupSetConfig(projectId, ws, sp || null, li || null);
      await loadConfig(projectId);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-bg-elev border border-border w-[420px] p-4 space-y-3" onClick={e => e.stopPropagation()}>
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">ZAKRES CLICKUP</span>
        <select
          className="w-full bg-bg border border-border px-2 py-1.5 text-[13px] disabled:opacity-50"
          value={ws}
          disabled={loadingWs}
          onChange={e => { setWs(e.target.value); setSp(''); setLi(''); }}
        >
          <option value="">{loadingWs ? '— Ładowanie… —' : '— Workspace —'}</option>
          {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select
          className="w-full bg-bg border border-border px-2 py-1.5 text-[13px] disabled:opacity-50"
          value={sp}
          disabled={!ws || loadingSp}
          onChange={e => { setSp(e.target.value); setLi(''); }}
        >
          <option value="">{loadingSp ? '— Ładowanie… —' : '— Space —'}</option>
          {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select
          className="w-full bg-bg border border-border px-2 py-1.5 text-[13px] disabled:opacity-50"
          value={li}
          disabled={!sp || loadingLi}
          onChange={e => setLi(e.target.value)}
        >
          <option value="">{loadingLi ? '— Ładowanie… —' : '— Lista (opcjonalnie) —'}</option>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {error && <p className="text-[11px] text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg"
            onClick={onClose}
          >
            Anuluj
          </button>
          <button
            disabled={busy || !ws}
            className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium disabled:opacity-50"
            onClick={save}
          >
            Zapisz
          </button>
        </div>
      </div>
    </div>
  );
}
