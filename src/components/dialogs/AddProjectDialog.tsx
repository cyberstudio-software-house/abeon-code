import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { tauri } from '../../lib/tauri';
import { useStore } from '../../store';
import type { DetectedScript } from '../../types';

type Props = { onClose: () => void };

export function AddProjectDialog({ onClose }: Props) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [scripts, setScripts] = useState<DetectedScript[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const addProject = useStore(s => s.addProject);

  useEffect(() => {
    if (!path) { setScripts([]); return; }
    tauri.detectScripts(path).then(setScripts).catch(() => setScripts([]));
  }, [path]);

  const pickFolder = async () => {
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === 'string') {
      setPath(sel);
      if (!name) setName(sel.split('/').pop() ?? sel);
    }
  };

  const toggle = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i); else next.add(i);
    setSelected(next);
  };

  const submit = async () => {
    setError(null);
    try {
      const project = await addProject(name.trim(), path.trim());
      for (const i of selected) {
        const s = scripts[i];
        await tauri.addAction({
          projectId: project.id, label: s.label, command: s.command,
          workingDir: null, source: s.source,
        });
      }
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border p-5 w-[520px] max-h-[80vh] overflow-auto">
        <h2 className="text-[14px] font-semibold mb-3">Dodaj projekt</h2>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Ścieżka</label>
        <div className="flex gap-2 mb-3">
          <input value={path} onChange={e => setPath(e.target.value)}
            className="flex-1 bg-bg border border-border px-3 py-1.5 text-[13px]" />
          <button onClick={pickFolder}
            className="px-3 py-1.5 border border-border bg-bg-elev-2 text-[12px] text-fg-secondary hover:text-fg">Wybierz…</button>
        </div>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Nazwa</label>
        <input value={name} onChange={e => setName(e.target.value)}
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] mb-4" />

        {scripts.length > 0 && (
          <>
            <div className="text-[11px] text-muted mb-2">Wykryte skrypty — wybierz, które dodać jako akcje:</div>
            <div className="space-y-0.5 mb-4 max-h-64 overflow-auto border border-border p-2">
              {scripts.map((s, i) => (
                <label key={`${s.source}-${s.label}-${i}`} className="flex items-center gap-2 py-1 cursor-pointer hover:bg-bg-elev-2 px-1">
                  <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} />
                  <span className="text-[10px] text-muted uppercase w-16">{s.source}</span>
                  <span className="font-mono text-[11px]">{s.label}</span>
                </label>
              ))}
            </div>
          </>
        )}

        {error && <div className="text-danger text-[13px] mb-3">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Anuluj</button>
          <button onClick={submit}
            className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium"
            disabled={!name.trim() || !path.trim()}>Dodaj</button>
        </div>
      </div>
    </div>
  );
}
