import { useEffect, useState } from 'react';
import { tauri } from '../../lib/tauri';
import type { ClickUpWorkspace } from '../../types/ClickUpWorkspace';
import type { ClickUpSpace } from '../../types/ClickUpSpace';
import type { ClickUpList } from '../../types/ClickUpList';

export function ClickUpScopeDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const [workspaces, setWorkspaces] = useState<ClickUpWorkspace[]>([]);
  const [spaces, setSpaces] = useState<ClickUpSpace[]>([]);
  const [lists, setLists] = useState<ClickUpList[]>([]);
  const [ws, setWs] = useState('');
  const [sp, setSp] = useState('');
  const [li, setLi] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    tauri.clickupListWorkspaces().then(setWorkspaces).catch(() => setWorkspaces([]));
  }, []);
  useEffect(() => {
    if (!ws) { setSpaces([]); return; }
    tauri.clickupListSpaces(ws).then(setSpaces).catch(() => setSpaces([]));
  }, [ws]);
  useEffect(() => {
    if (!sp) { setLists([]); return; }
    tauri.clickupListLists(sp).then(setLists).catch(() => setLists([]));
  }, [sp]);

  const save = async () => {
    setBusy(true);
    try {
      await tauri.clickupSetConfig(projectId, ws, sp || null, li || null);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-bg-elev border border-border w-[420px] p-4 space-y-3" onClick={e => e.stopPropagation()}>
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">ZAKRES CLICKUP</span>
        <select
          className="w-full bg-bg border border-border px-2 py-1.5 text-[13px]"
          value={ws}
          onChange={e => { setWs(e.target.value); setSp(''); setLi(''); }}
        >
          <option value="">— Workspace —</option>
          {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select
          className="w-full bg-bg border border-border px-2 py-1.5 text-[13px]"
          value={sp}
          onChange={e => { setSp(e.target.value); setLi(''); }}
        >
          <option value="">— Space —</option>
          {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select
          className="w-full bg-bg border border-border px-2 py-1.5 text-[13px]"
          value={li}
          onChange={e => setLi(e.target.value)}
        >
          <option value="">— Lista (opcjonalnie) —</option>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
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
