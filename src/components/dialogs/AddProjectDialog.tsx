import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useStore } from '../../store';

type Props = { onClose: () => void };

export function AddProjectDialog({ onClose }: Props) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const addProject = useStore(s => s.addProject);

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') {
      setPath(selected);
      if (!name) setName(selected.split('/').pop() ?? selected);
    }
  };

  const submit = async () => {
    setError(null);
    try {
      await addProject(name.trim(), path.trim());
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border rounded-lg p-5 w-[420px]">
        <h2 className="text-lg font-semibold mb-3">Dodaj projekt</h2>
        <label className="block text-xs text-muted mb-1">Ścieżka katalogu</label>
        <div className="flex gap-2 mb-3">
          <input value={path} onChange={e => setPath(e.target.value)}
            className="flex-1 bg-bg border border-border rounded px-2 py-1" />
          <button onClick={pickFolder}
            className="px-3 py-1 border border-border rounded bg-bg-elev-2">Wybierz…</button>
        </div>
        <label className="block text-xs text-muted mb-1">Nazwa</label>
        <input value={name} onChange={e => setName(e.target.value)}
          className="w-full bg-bg border border-border rounded px-2 py-1 mb-3" />
        {error && <div className="text-danger text-sm mb-3">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 border border-border rounded">Anuluj</button>
          <button onClick={submit}
            className="px-3 py-1 bg-accent text-accent-fg rounded"
            disabled={!name.trim() || !path.trim()}>Dodaj</button>
        </div>
      </div>
    </div>
  );
}
