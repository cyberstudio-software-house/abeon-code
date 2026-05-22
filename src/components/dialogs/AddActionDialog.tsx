import { useEffect, useState } from 'react';
import { tauri } from '../../lib/tauri';
import type { DetectedScript } from '../../types';

type Props = { projectId: number; projectPath: string; onClose: () => void; onAdded: () => void };

export function AddActionDialog({ projectId, projectPath, onClose, onAdded }: Props) {
  const [scripts, setScripts] = useState<DetectedScript[]>([]);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');

  useEffect(() => {
    tauri.detectScripts(projectPath).then(setScripts).catch(() => {});
  }, [projectPath]);

  const useDetected = (s: DetectedScript) => {
    setLabel(s.label);
    setCommand(s.command);
  };

  const submit = async () => {
    await tauri.addAction({
      projectId, label: label.trim(), command: command.trim(),
      workingDir: null, source: 'manual',
    });
    onAdded();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border rounded-lg p-5 w-[480px] max-h-[80vh] overflow-auto">
        <h2 className="text-lg font-semibold mb-3">Dodaj akcję</h2>
        {scripts.length > 0 && (
          <div className="mb-3">
            <div className="text-xs text-muted mb-1">Wykryte skrypty (kliknij aby uzupełnić pola):</div>
            <div className="space-y-1 max-h-40 overflow-auto border border-border rounded p-2">
              {scripts.map((s, i) => (
                <button key={i} onClick={() => useDetected(s)}
                  className="w-full text-left px-2 py-1 rounded hover:bg-bg-elev-2 text-xs">
                  <span className="text-[10px] text-muted uppercase mr-2">{s.source}</span>
                  <span className="font-mono">{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="block text-xs text-muted mb-1">Etykieta</label>
        <input value={label} onChange={e => setLabel(e.target.value)}
          className="w-full bg-bg border border-border rounded px-2 py-1 mb-3" />
        <label className="block text-xs text-muted mb-1">Komenda</label>
        <input value={command} onChange={e => setCommand(e.target.value)}
          className="w-full bg-bg border border-border rounded px-2 py-1 mb-4 font-mono text-xs" />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 border border-border rounded">Anuluj</button>
          <button onClick={submit} disabled={!label.trim() || !command.trim()}
            className="px-3 py-1 bg-accent text-accent-fg rounded">Dodaj</button>
        </div>
      </div>
    </div>
  );
}
